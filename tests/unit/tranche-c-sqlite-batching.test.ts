/**
 * Tranche C #15 regression tests for SQLite IN-clause chunking.
 *
 * Two bulk-delete code paths used `ids.map(() => "?").join(", ")` directly,
 * which could exceed SQLite's SQLITE_MAX_VARIABLE_NUMBER limit (999 on
 * older builds, 32766 on modern). The fix chunks the IN list into batches
 * of <=500 and wraps every chunk inside a single transaction so the rows
 * commit or roll back atomically.
 *
 * Tested code paths:
 *
 *   - `deleteCallLogsBefore` → `deleteCallLogRowsByIds`
 *     (src/lib/usage/callLogs.ts)
 *
 *   - `deleteProviderConnections` (src/lib/db/providers.ts)
 *
 * The test seeds 5000 rows in each table, deletes all of them in one call,
 * and verifies (a) every row is gone, (b) `db.transaction(...)` was used to
 * wrap the deletes, and (c) every prepared DELETE statement contained at
 * most 500 placeholders.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-tranche-c-sqlite-batch-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.CALL_LOG_RETENTION_DAYS = "3650";
process.env.CALL_LOG_MAX_ENTRIES = "100000";

const core = await import("../../src/lib/db/core.ts");
const callLogs = await import("../../src/lib/usage/callLogs.ts");
const providersDb = await import("../../src/lib/db/providers.ts");

const BATCH_LIMIT = 500;

function reset() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

/**
 * Wrap `db.prepare(sql)` to record SQL strings (and placeholder counts) and
 * `db.transaction(fn)` to count wrapping calls. Returns a snapshot helper.
 */
function installSqlSpy() {
  const db = core.getDbInstance();
  const originalPrepare = db.prepare.bind(db);
  const originalTransaction = db.transaction.bind(db);

  const preparedSql: string[] = [];
  let transactionCalls = 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db as any).prepare = (sql: string) => {
    preparedSql.push(sql);
    return originalPrepare(sql);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db as any).transaction = (fn: any) => {
    transactionCalls++;
    return originalTransaction(fn);
  };

  return {
    preparedSql,
    get transactionCalls() {
      return transactionCalls;
    },
    uninstall() {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (db as any).prepare = originalPrepare;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (db as any).transaction = originalTransaction;
    },
  };
}

function countPlaceholders(sql: string): number {
  // Count "?" placeholders in a parameterised statement. Good enough for
  // the simple INSERT/DELETE statements we issue here — none of them
  // contain literal "?" inside string literals.
  return (sql.match(/\?/g) ?? []).length;
}

test.beforeEach(() => {
  reset();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("deleteCallLogRowsByIds (via deleteCallLogsBefore) chunks 5000 ids into <=500-wide batches inside a single transaction", async () => {
  const db = core.getDbInstance();

  // Seed 5000 rows with timestamps in the past so a single
  // `deleteCallLogsBefore` call selects all of them.
  const insert = db.prepare(
    "INSERT INTO call_logs (id, timestamp, method, path, status, detail_state) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const seedTx = db.transaction(() => {
    for (let i = 0; i < 5000; i++) {
      insert.run(
        `bulk-${i}`,
        new Date(2000, 0, 1, 0, 0, i % 60).toISOString(),
        "POST",
        "/v1/chat/completions",
        200,
        "none"
      );
    }
  });
  seedTx();

  const countBefore = (db.prepare("SELECT COUNT(*) AS c FROM call_logs").get() as { c: number }).c;
  assert.equal(countBefore, 5000, "seed: 5000 rows present before delete");

  const spy = installSqlSpy();
  try {
    const result = callLogs.deleteCallLogsBefore("3000-01-01T00:00:00.000Z");

    // (a) Every row was deleted.
    assert.equal(result.deletedRows, 5000);
    const countAfter = (db.prepare("SELECT COUNT(*) AS c FROM call_logs").get() as { c: number }).c;
    assert.equal(countAfter, 0);

    // (b) `db.transaction(...)` was invoked exactly once (the chunk loop
    //     runs inside a single transaction, not one per batch).
    assert.equal(
      spy.transactionCalls,
      1,
      "deleteCallLogRowsByIds must wrap all chunks in a single transaction"
    );

    // (c) Every DELETE/SELECT statement prepared by the deletion path used
    //     <=500 placeholders.
    const deleteSqls = spy.preparedSql.filter((s) => /DELETE FROM call_logs WHERE id IN/.test(s));
    assert.ok(deleteSqls.length >= 10, "expected >=10 DELETE chunks for 5000 ids @ batch=500");
    for (const sql of deleteSqls) {
      const placeholders = countPlaceholders(sql);
      assert.ok(
        placeholders > 0 && placeholders <= BATCH_LIMIT,
        `prepared DELETE must use <= ${BATCH_LIMIT} placeholders; saw ${placeholders}`
      );
    }
    // The SELECT artifact_relpath FROM call_logs WHERE id IN (...) is
    // issued per chunk too — same limit applies.
    const selectSqls = spy.preparedSql.filter((s) =>
      /SELECT artifact_relpath FROM call_logs WHERE id IN/.test(s)
    );
    assert.ok(selectSqls.length >= 10, "expected >=10 SELECT chunks for 5000 ids @ batch=500");
    for (const sql of selectSqls) {
      const placeholders = countPlaceholders(sql);
      assert.ok(
        placeholders > 0 && placeholders <= BATCH_LIMIT,
        `prepared SELECT must use <= ${BATCH_LIMIT} placeholders; saw ${placeholders}`
      );
    }
  } finally {
    spy.uninstall();
  }
});

test("deleteCallLogRowsByIds with an empty id list is a no-op (no transaction, no statements)", async () => {
  const spy = installSqlSpy();
  try {
    // deleteCallLogsBefore with a cutoff older than every possible row
    // produces an empty id array, which short-circuits the helper.
    const result = callLogs.deleteCallLogsBefore("0001-01-01T00:00:00.000Z");
    assert.deepEqual(result, { deletedRows: 0, deletedArtifacts: 0 });

    // The selection query for ids runs (it produced the empty array), but
    // no DELETE statement and no `db.transaction(...)` wrapper should
    // appear afterwards.
    assert.equal(spy.transactionCalls, 0, "empty ids list must not open a transaction");
    const deleteSqls = spy.preparedSql.filter((s) => /DELETE FROM call_logs WHERE id IN/.test(s));
    assert.equal(deleteSqls.length, 0, "empty ids list must not prepare any DELETE statement");
  } finally {
    spy.uninstall();
  }
});

test("deleteProviderConnections chunks 5000 ids into <=500-wide batches inside a single transaction", async () => {
  const db = core.getDbInstance();

  const insertConn = db.prepare(
    "INSERT INTO provider_connections (id, provider, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
  );
  const seedTx = db.transaction(() => {
    const now = new Date().toISOString();
    for (let i = 0; i < 5000; i++) {
      insertConn.run(`conn-${i}`, "openai", `acct-${i}`, now, now);
    }
  });
  seedTx();

  const countBefore = (
    db.prepare("SELECT COUNT(*) AS c FROM provider_connections").get() as { c: number }
  ).c;
  assert.equal(countBefore, 5000);

  const spy = installSqlSpy();
  try {
    const ids = Array.from({ length: 5000 }, (_, i) => `conn-${i}`);
    const deleted = await providersDb.deleteProviderConnections(ids);

    assert.equal(deleted, 5000, "every seeded connection must be deleted");
    const countAfter = (
      db.prepare("SELECT COUNT(*) AS c FROM provider_connections").get() as { c: number }
    ).c;
    assert.equal(countAfter, 0);

    assert.equal(
      spy.transactionCalls,
      1,
      "deleteProviderConnections must wrap all chunks in a single transaction"
    );

    const deleteSqls = spy.preparedSql.filter((s) =>
      /DELETE FROM provider_connections WHERE id IN/.test(s)
    );
    assert.ok(deleteSqls.length >= 10, "expected >=10 DELETE chunks for 5000 ids @ batch=500");
    for (const sql of deleteSqls) {
      const placeholders = countPlaceholders(sql);
      assert.ok(
        placeholders > 0 && placeholders <= BATCH_LIMIT,
        `prepared DELETE must use <= ${BATCH_LIMIT} placeholders; saw ${placeholders}`
      );
    }
  } finally {
    spy.uninstall();
  }
});

test("deleteProviderConnections with an empty id list is a no-op", async () => {
  const spy = installSqlSpy();
  try {
    const deleted = await providersDb.deleteProviderConnections([]);
    assert.equal(deleted, 0);
    assert.equal(spy.transactionCalls, 0, "empty ids list must not open a transaction");
    assert.equal(
      spy.preparedSql.filter((s) => /DELETE FROM/.test(s)).length,
      0,
      "empty ids list must not prepare any DELETE"
    );
  } finally {
    spy.uninstall();
  }
});
