/**
 * Tranche C consolidated regression suite — closes 7 remaining items from
 * the original 24-item bug review:
 *
 *   #12  open-sse/utils/streamHandler.ts  — pipeWithDisconnect no-op writer
 *                                           was simplified to drop the fake
 *                                           writable indirection; covered
 *                                           structurally by the dedicated
 *                                           tranche-c-stream-abort.test.ts.
 *   #13  src/lib/db/apiKeys.ts             — negative-cache for the truly
 *                                           "key does not exist" branch only.
 *   #14  src/lib/db/apiKeys.ts             — hash-only lookup; legacy
 *                                           plaintext fallback gated behind
 *                                           OMNIROUTE_LEGACY_PLAINTEXT_KEYS.
 *   #15  src/lib/usage/callLogs.ts +       — chunk IN-list parameters to
 *        src/lib/db/providers.ts            stay under SQLITE_MAX_VARIABLE_NUMBER.
 *   #18  open-sse/services/combo.ts        — weighted fallback warns + falls
 *                                           back to targets[0] when the
 *                                           selected key vanishes.
 *   #22  open-sse/services/tokenRefresh.ts — sha256 cache key instead of
 *                                           PBKDF2 (cache key is not a
 *                                           credential).
 *   #24  open-sse/services/combo.ts        — explicit FP residue fallback
 *                                           and zero-totalWeight uniform pick.
 *
 * Hermetic only — no real upstream, no network. The DB tests use a temp
 * DATA_DIR and reset the SQLite singleton between cases. Each `it` bundles
 * the full assertion set for its suite (5 suites = 5 tests total).
 */
import { describe, it, after, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-tranche-c-fixes-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "tranche-c-test-secret";
process.env.CALL_LOG_RETENTION_DAYS = "3650";
process.env.CALL_LOG_MAX_ENTRIES = "100000";
delete process.env.OMNIROUTE_LEGACY_PLAINTEXT_KEYS;
delete process.env.OMNIROUTE_API_KEY;
delete process.env.ROUTER_API_KEY;

const core = await import("../../src/lib/db/core.ts");
const callLogs = await import("../../src/lib/usage/callLogs.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const tokenRefresh = await import("../../open-sse/services/tokenRefresh.ts");
const comboMod = await import("../../open-sse/services/combo.ts");

const BATCH_LIMIT = 500;

function resetDb() {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

after(() => {
  try {
    core.resetDbInstance();
  } catch {
    /* noop */
  }
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

/**
 * Wrap `db.prepare(sql)` so every Statement returned from it records its
 * SQL and counts `.get(...)` calls. Wraps `db.transaction(fn)` to count
 * wrapper-creation calls. Returns a snapshot helper.
 */
function installSqlSpy() {
  const db = core.getDbInstance();
  const originalPrepare = db.prepare.bind(db);
  const originalTransaction = db.transaction.bind(db);

  const preparedSql: string[] = [];
  let transactionCalls = 0;
  let getCalls = 0;

  /* eslint-disable @typescript-eslint/no-explicit-any */
  (db as any).prepare = (sql: string) => {
    preparedSql.push(sql);
    const stmt = originalPrepare(sql);
    const originalGet = stmt.get.bind(stmt);
    (stmt as any).get = (...args: unknown[]) => {
      getCalls++;
      return originalGet(...args);
    };
    return stmt;
  };
  (db as any).transaction = (fn: any) => {
    transactionCalls++;
    return originalTransaction(fn);
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return {
    preparedSql,
    get transactionCalls() {
      return transactionCalls;
    },
    get getCalls() {
      return getCalls;
    },
    uninstall() {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      (db as any).prepare = originalPrepare;
      (db as any).transaction = originalTransaction;
      /* eslint-enable @typescript-eslint/no-explicit-any */
    },
  };
}

function countPlaceholders(sql: string): number {
  return (sql.match(/\?/g) ?? []).length;
}

// ──────────────────────────────────────────────────────────────────────────
// Suite 1 — #15 SQLite IN-list batching
// ──────────────────────────────────────────────────────────────────────────
describe("Tranche C #15 — SQLite IN-list parameter chunking", () => {
  beforeEach(() => {
    resetDb();
  });

  it("chunks 5000 ids into <=500-wide DELETE batches in a single transaction; empty input is a no-op", async () => {
    const db = core.getDbInstance();

    // --- callLogs path: 5000-id batching contract --------------------------
    const insertCallLog = db.prepare(
      "INSERT INTO call_logs (id, timestamp, method, path, status, detail_state) VALUES (?, ?, ?, ?, ?, ?)"
    );
    const seedCallLogs = db.transaction(() => {
      for (let i = 0; i < 5000; i++) {
        insertCallLog.run(
          `bulk-${i}`,
          new Date(2000, 0, 1, 0, 0, i % 60).toISOString(),
          "POST",
          "/v1/chat/completions",
          200,
          "none"
        );
      }
    });
    seedCallLogs();
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS c FROM call_logs").get() as { c: number }).c,
      5000
    );

    const callLogSpy = installSqlSpy();
    try {
      const result = callLogs.deleteCallLogsBefore("3000-01-01T00:00:00.000Z");
      assert.equal(result.deletedRows, 5000, "every seeded call_log row must be deleted");
      assert.equal(
        callLogSpy.transactionCalls,
        1,
        "deleteCallLogRowsByIds must wrap all chunks in a single db.transaction()"
      );
      const callLogDeletes = callLogSpy.preparedSql.filter((s) =>
        /DELETE FROM call_logs WHERE id IN/.test(s)
      );
      assert.ok(
        callLogDeletes.length >= 10,
        `expected >=10 DELETE chunks for 5000 ids at batch=${BATCH_LIMIT}; got ${callLogDeletes.length}`
      );
      for (const sql of callLogDeletes) {
        const placeholders = countPlaceholders(sql);
        assert.ok(
          placeholders > 0 && placeholders <= BATCH_LIMIT,
          `DELETE chunk must use 1..${BATCH_LIMIT} placeholders; saw ${placeholders}`
        );
      }
    } finally {
      callLogSpy.uninstall();
    }

    // --- providers path: 5000-id batching contract -------------------------
    const insertConn = db.prepare(
      "INSERT INTO provider_connections (id, provider, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    );
    const nowIso = new Date().toISOString();
    const seedConns = db.transaction(() => {
      for (let i = 0; i < 5000; i++) {
        insertConn.run(`conn-${i}`, "openai", `acct-${i}`, nowIso, nowIso);
      }
    });
    seedConns();

    const provSpy = installSqlSpy();
    try {
      const ids = Array.from({ length: 5000 }, (_, i) => `conn-${i}`);
      const deleted = await providersDb.deleteProviderConnections(ids);
      assert.equal(deleted, 5000, "every seeded provider_connections row must be deleted");
      assert.equal(
        provSpy.transactionCalls,
        1,
        "deleteProviderConnections must wrap all chunks in a single db.transaction()"
      );
      const provDeletes = provSpy.preparedSql.filter((s) =>
        /DELETE FROM provider_connections WHERE id IN/.test(s)
      );
      assert.ok(
        provDeletes.length >= 10,
        `expected >=10 provider DELETE chunks for 5000 ids; got ${provDeletes.length}`
      );
      for (const sql of provDeletes) {
        const placeholders = countPlaceholders(sql);
        assert.ok(
          placeholders > 0 && placeholders <= BATCH_LIMIT,
          `provider DELETE chunk must use 1..${BATCH_LIMIT} placeholders; saw ${placeholders}`
        );
      }
    } finally {
      provSpy.uninstall();
    }

    // --- empty input is a no-op (no transaction, no DELETE) ----------------
    const noopSpy = installSqlSpy();
    try {
      // A cutoff older than any possible row produces an empty id list,
      // which must short-circuit before any DB activity.
      const r1 = callLogs.deleteCallLogsBefore("0001-01-01T00:00:00.000Z");
      assert.deepEqual(r1, { deletedRows: 0, deletedArtifacts: 0 });
      const r2 = await providersDb.deleteProviderConnections([]);
      assert.equal(r2, 0);
      assert.equal(
        noopSpy.transactionCalls,
        0,
        "empty input must not open any new db.transaction()"
      );
      assert.equal(
        noopSpy.preparedSql.filter((s) => /DELETE FROM/.test(s)).length,
        0,
        "empty input must prepare zero DELETE statements"
      );
    } finally {
      noopSpy.uninstall();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Suite 2 — #13 validateApiKey negative cache
// ──────────────────────────────────────────────────────────────────────────
describe("Tranche C #13 — validateApiKey negative cache", () => {
  beforeEach(() => {
    resetDb();
  });

  it("caches 'key does not exist' rejection only; revoked path is NOT cached", async () => {
    // (a) Negative caching for unknown keys: second call within TTL must
    //     not touch the DB.
    const spy = installSqlSpy();
    try {
      const bogus = "sk-tranche-c-unknown-key-12345";
      assert.equal(await apiKeysDb.validateApiKey(bogus), false);
      const afterFirst = spy.getCalls;
      assert.ok(afterFirst >= 1, "first validation should issue at least one statement.get()");

      assert.equal(await apiKeysDb.validateApiKey(bogus), false);
      assert.equal(
        spy.getCalls,
        afterFirst,
        "second call within NEGATIVE_CACHE_TTL must be served from cache (no extra .get())"
      );
    } finally {
      spy.uninstall();
    }

    // (b) Revoked keys must NOT be cached as negative — un-revoking via raw
    //     SQL (bypassing invalidateCaches) must take effect on the very
    //     next call.
    const created = await apiKeysDb.createApiKey("tranche-c-revoke", "machine-revoke");
    assert.ok(created?.key);
    assert.equal(await apiKeysDb.validateApiKey(created.key), true);
    assert.equal(await apiKeysDb.revokeApiKey(created.id), true);
    assert.equal(await apiKeysDb.validateApiKey(created.key), false);
    const db = core.getDbInstance();
    db.prepare("UPDATE api_keys SET revoked_at = NULL, is_active = 1 WHERE id = ?").run(created.id);
    assert.equal(
      await apiKeysDb.validateApiKey(created.key),
      true,
      "un-revoked key must validate immediately — revoked path must not be cached"
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Suite 3 — #14 hash-first lookup
// ──────────────────────────────────────────────────────────────────────────
describe("Tranche C #14 — validateApiKey hash-first lookup", () => {
  beforeEach(() => {
    resetDb();
  });

  it("default mode prepares only WHERE key_hash = ?; legacy plaintext branch is statically gated", async () => {
    // (a) Behavioral: with the env flag unset, validateApiKey must only
    //     prepare the hash-form statement and never the plaintext-only or
    //     legacy OR form.
    const spy = installSqlSpy();
    try {
      await apiKeysDb.validateApiKey("sk-irrelevant-key-for-prepare");

      const hashSqls = spy.preparedSql.filter((s) =>
        /SELECT .* FROM api_keys WHERE key_hash = \?/.test(s)
      );
      const plaintextSqls = spy.preparedSql.filter(
        (s) => /SELECT .* FROM api_keys WHERE key = \?(?!\s*OR)/.test(s) && !/key_hash/.test(s)
      );
      const orSqls = spy.preparedSql.filter((s) =>
        /SELECT .* FROM api_keys WHERE key = \? OR key_hash = \?/.test(s)
      );

      assert.ok(hashSqls.length >= 1, "validateApiKey must prepare a WHERE key_hash = ? statement");
      assert.equal(
        plaintextSqls.length,
        0,
        `legacy WHERE key = ? lookup must NOT be prepared when OMNIROUTE_LEGACY_PLAINTEXT_KEYS is unset; saw ${plaintextSqls.length}`
      );
      assert.equal(
        orSqls.length,
        0,
        "the old WHERE key = ? OR key_hash = ? form must be gone from the validate path"
      );
    } finally {
      spy.uninstall();
    }

    // (b) Behavioral sanity: a key created in default mode still validates
    //     true through the hash-only path.
    const created = await apiKeysDb.createApiKey("tranche-c-14", "machine-14");
    assert.ok(created?.key);
    assert.equal(await apiKeysDb.validateApiKey(created.key), true);

    // (c) Structural: LEGACY_PLAINTEXT_KEYS is captured at module load so a
    //     same-process env mutation cannot flip behavior. Pin the contract
    //     by inspecting the source: validateApiKey must only consult the
    //     plaintext statement when the hash lookup returned no row AND the
    //     legacy env flag is set.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const apiKeysSource = fs.readFileSync(
      path.resolve(here, "../../src/lib/db/apiKeys.ts"),
      "utf8"
    );
    assert.match(
      apiKeysSource,
      /let row = stmt\.validateKey\.get\(hashedKey\)/,
      "hash lookup must be the first prepared-statement get() inside validateApiKey"
    );
    assert.match(
      apiKeysSource,
      /if \(!row && LEGACY_PLAINTEXT_KEYS && stmt\.validateKeyByPlaintext\)/,
      "plaintext fallback must be guarded by (!row && LEGACY_PLAINTEXT_KEYS && plaintext stmt)"
    );
    assert.match(
      apiKeysSource,
      /const LEGACY_PLAINTEXT_KEYS = process\.env\.OMNIROUTE_LEGACY_PLAINTEXT_KEYS === "1"/,
      "legacy mode must be gated behind OMNIROUTE_LEGACY_PLAINTEXT_KEYS=1"
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Suite 4 — #22 sha256 cache key (no PBKDF2)
// ──────────────────────────────────────────────────────────────────────────
describe("Tranche C #22 — tokenRefresh cache key uses sha256, not PBKDF2", () => {
  it("returns provider:<64-hex-chars> matching sha256(provider:refreshToken); pbkdf2Sync is gone from the source", () => {
    // (a) Format / determinism / cross-provider isolation.
    const provider = "openai";
    const refreshToken = "refresh_xyz";

    const key = tokenRefresh.getRefreshCacheKey(provider, refreshToken);
    const match = /^([^:]+):([0-9a-f]+)$/.exec(key);
    assert.ok(match, `cache key must match provider:<hex> shape; got ${key}`);
    assert.equal(match[1], provider, "cache key must be prefixed by the provider id");
    assert.equal(
      match[2].length,
      64,
      `cache key hex segment must be 64 chars (sha256); got ${match[2].length}`
    );
    const expectedHex = createHash("sha256")
      .update(provider)
      .update(":")
      .update(refreshToken)
      .digest("hex");
    assert.equal(match[2], expectedHex, "cache key must be sha256(provider + ':' + refreshToken)");

    // Different providers with the same token must produce different keys.
    const otherKey = tokenRefresh.getRefreshCacheKey("anthropic", refreshToken);
    assert.notEqual(otherKey, key);

    // (b) Source-level confirmation that the expensive PBKDF2 path is gone.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = fs.readFileSync(
      path.resolve(here, "../../open-sse/services/tokenRefresh.ts"),
      "utf8"
    );
    assert.ok(
      !/\bpbkdf2Sync\b/.test(source),
      "tokenRefresh.ts must not reference pbkdf2Sync after Tranche C #22"
    );
    assert.ok(!/\bCACHE_SECRET\b/.test(source), "obsolete CACHE_SECRET constant must be removed");
    assert.match(
      source,
      /import\s*{[^}]*\bcreateHash\b[^}]*}\s*from\s*"node:crypto"/,
      "tokenRefresh.ts must import createHash from node:crypto"
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Suite 5 — #18 + #24 weighted combo selection
// ──────────────────────────────────────────────────────────────────────────
describe("Tranche C #18 + #24 — weighted combo selection", () => {
  type WeightedTarget = { executionKey: string; weight: number };

  it("zero-totalWeight picks uniformly; missing executionKey warns + falls back to targets[0]; FP residue returns last target", () => {
    // (a) #24 — totalWeight === 0 must pick uniformly. Run 1000 trials and
    //     assert each bucket lands near N/3.
    const zeroWeightTargets: WeightedTarget[] = [
      { executionKey: "a", weight: 0 },
      { executionKey: "b", weight: 0 },
      { executionKey: "c", weight: 0 },
    ];
    const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
    const N = 1000;
    for (let i = 0; i < N; i++) {
      const picked = comboMod.selectWeightedTarget(zeroWeightTargets);
      assert.ok(picked, "zero-totalWeight must still return a target");
      counts[picked.executionKey] = (counts[picked.executionKey] ?? 0) + 1;
    }
    for (const k of ["a", "b", "c"] as const) {
      assert.ok(
        counts[k] > N / 6 && counts[k] < N / 2,
        `uniform-on-zero pick for "${k}" should be near N/3; got ${counts[k]} of ${N}`
      );
    }

    // (b) #18 — missing executionKey must warn and substitute targets[0]
    //     as the head.
    const targets: WeightedTarget[] = [
      { executionKey: "alpha", weight: 5 },
      { executionKey: "beta", weight: 3 },
      { executionKey: "gamma", weight: 1 },
    ];
    const warnings: Array<{ tag: string; message: string; data: unknown }> = [];
    const log = {
      warn: (tag: string, message: string, data?: unknown) => {
        warnings.push({ tag, message, data });
      },
    };
    const ordered = comboMod.orderTargetsForWeightedFallback(
      targets,
      "no-such-key",
      /* preserveExistingOrder */ false,
      log
    );
    assert.equal(warnings.length, 1, "must emit exactly one warn() on race fallback");
    assert.equal(warnings[0].tag, "COMBO");
    assert.match(warnings[0].message, /Weighted fallback could not find the selected executionKey/);
    assert.deepEqual(
      (warnings[0].data as Record<string, unknown>).selectedExecutionKey,
      "no-such-key"
    );
    assert.deepEqual((warnings[0].data as Record<string, unknown>).availableKeys, [
      "alpha",
      "beta",
      "gamma",
    ]);
    assert.ok(ordered.length >= 1);
    assert.ok(ordered[0]);
    assert.equal(ordered[0].executionKey, "alpha", "head falls back to targets[0]");
    const tailKeys = ordered.slice(1).map((t) => t.executionKey);
    assert.ok(!tailKeys.includes("alpha"), "alpha must not be duplicated in the tail");
    assert.deepEqual(tailKeys, ["beta", "gamma"]);

    // (c) #24 — floating-point residue must return targets[N-1] explicitly.
    const fpTargets: WeightedTarget[] = [
      { executionKey: "first", weight: 1 },
      { executionKey: "mid", weight: 1 },
      { executionKey: "last", weight: 1 },
    ];
    const originalRandom = Math.random;
    try {
      Math.random = () => 0.9999999999999999;
      const picked = comboMod.selectWeightedTarget(fpTargets);
      assert.ok(picked, "FP-residue fallback must not return undefined");
      assert.equal(
        picked.executionKey,
        "last",
        "FP-residue path must return targets[N-1] explicitly"
      );
    } finally {
      Math.random = originalRandom;
    }

    // (d) Empty target list must return null.
    assert.equal(comboMod.selectWeightedTarget([]), null);
  });
});
