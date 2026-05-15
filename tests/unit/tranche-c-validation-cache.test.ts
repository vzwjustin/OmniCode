/**
 * Tranche C #13 regression tests for `validateApiKey` negative caching.
 *
 * Pins three guarantees:
 *
 *   1. After a "key does not exist" lookup, a second lookup within
 *      NEGATIVE_CACHE_TTL must NOT hit the SQLite prepared statement
 *      (the cache short-circuits the query).
 *
 *   2. The negative-cache TTL is strictly shorter than the positive-cache
 *      TTL — a brand-new key must validate immediately after the negative
 *      window expires, while a valid key remains cached far longer.
 *
 *   3. We do NOT populate the negative cache for revoked / expired / banned
 *      keys. Operator-driven state transitions (unban, un-revoke, push
 *      expiry forward) must take effect on the very next request, not after
 *      up to NEGATIVE_CACHE_TTL of stale negative cache.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-tranche-c-validation-cache-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "tranche-c-test-secret";

const core = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");

const ORIGINAL_OMNIROUTE_API_KEY = process.env.OMNIROUTE_API_KEY;
const ORIGINAL_ROUTER_API_KEY = process.env.ROUTER_API_KEY;

/**
 * Wrap `db.prepare(sql)` so every Statement returned from it carries a
 * counter on `.get(...)`. Returns a `{ getCalls }` object whose `.value`
 * reflects the running total. Must be installed BEFORE the first
 * `validateApiKey` call so the memoized prepared statements pick up the
 * wrapped Statement instance.
 */
function installPrepareSpy(): {
  getCalls: { value: number };
  uninstall: () => void;
} {
  const db = core.getDbInstance();
  const originalPrepare = db.prepare.bind(db);
  const counter = { value: 0 };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db as any).prepare = (sql: string) => {
    const stmt = originalPrepare(sql);
    const originalGet = stmt.get.bind(stmt);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (stmt as any).get = (...args: unknown[]) => {
      counter.value++;
      return originalGet(...args);
    };
    return stmt;
  };

  return {
    getCalls: counter,
    uninstall() {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (db as any).prepare = originalPrepare;
    },
  };
}

function reset() {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  delete process.env.OMNIROUTE_API_KEY;
  delete process.env.ROUTER_API_KEY;
}

test.beforeEach(() => {
  reset();
});

test.after(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  if (ORIGINAL_OMNIROUTE_API_KEY === undefined) delete process.env.OMNIROUTE_API_KEY;
  else process.env.OMNIROUTE_API_KEY = ORIGINAL_OMNIROUTE_API_KEY;
  if (ORIGINAL_ROUTER_API_KEY === undefined) delete process.env.ROUTER_API_KEY;
  else process.env.ROUTER_API_KEY = ORIGINAL_ROUTER_API_KEY;
});

test("negative cache: second lookup for an unknown key does not touch the DB", async () => {
  // Install the spy BEFORE the first validateApiKey call so the prepared
  // statement (memoized inside apiKeys.ts) returns the wrapped Statement.
  const spy = installPrepareSpy();
  try {
    const bogus = "sk-tranche-c-unknown-key-12345";

    // First call: must hit the DB (cache miss).
    assert.equal(await apiKeysDb.validateApiKey(bogus), false);
    const callsAfterFirst = spy.getCalls.value;
    assert.ok(callsAfterFirst >= 1, "first call should issue at least one statement.get()");

    // Second call within the negative-cache window: must NOT hit the DB.
    assert.equal(await apiKeysDb.validateApiKey(bogus), false);
    assert.equal(
      spy.getCalls.value,
      callsAfterFirst,
      "second call within NEGATIVE_CACHE_TTL must be served from cache (no extra .get())"
    );
  } finally {
    spy.uninstall();
  }
});

test("negative cache TTL is shorter than positive cache TTL", async () => {
  // We don't import the constants directly because they're not exported.
  // Instead we observe behavior: a fresh negative entry must expire and
  // re-query the DB after a small wait, while a positive entry stays
  // cached. To keep the test runtime small we only wait the
  // NEGATIVE_CACHE_TTL (5s) — well under CACHE_TTL (60s).

  // Install the spy FIRST so it catches the prepared statements when the
  // memoized cache is built on the first validateApiKey call. Otherwise the
  // statement cached in apiKeys.ts holds the un-wrapped `.get()` method and
  // every subsequent call bypasses our counter.
  const spy = installPrepareSpy();
  try {
    // 1. Validate an unknown key — caches `valid: false` with negative TTL.
    const bogus = "sk-tranche-c-ttl-unknown-key";
    assert.equal(await apiKeysDb.validateApiKey(bogus), false);
    const negativeCacheGets = spy.getCalls.value;
    assert.ok(negativeCacheGets >= 1, "first negative validation must touch the DB");

    // 2. Create a real key and validate it — caches `valid: true` with positive TTL.
    const created = await apiKeysDb.createApiKey("tranche-c-ttl", "machine-ttl");
    assert.ok(created?.key);
    const beforeValidPositive = spy.getCalls.value;
    assert.equal(await apiKeysDb.validateApiKey(created.key), true);
    const afterValidPositive = spy.getCalls.value;
    assert.ok(
      afterValidPositive > beforeValidPositive,
      "first positive validation must touch the DB"
    );

    // 3. Wait beyond NEGATIVE_CACHE_TTL (5s) but well under CACHE_TTL (60s).
    await new Promise((r) => setTimeout(r, 5_200));

    // Negative entry expired → DB re-query expected.
    const beforeNegativeRecheck = spy.getCalls.value;
    assert.equal(await apiKeysDb.validateApiKey(bogus), false);
    assert.ok(
      spy.getCalls.value > beforeNegativeRecheck,
      "after NEGATIVE_CACHE_TTL elapses, negative lookup must hit the DB again"
    );

    // Positive entry still cached → no DB re-query for the validation row.
    const beforePositiveRecheck = spy.getCalls.value;
    assert.equal(await apiKeysDb.validateApiKey(created.key), true);
    assert.equal(
      spy.getCalls.value,
      beforePositiveRecheck,
      "after NEGATIVE_CACHE_TTL elapses, positive lookup must STILL be cached (CACHE_TTL > NEGATIVE_CACHE_TTL)"
    );
  } finally {
    spy.uninstall();
  }
});

test("revoked keys are NOT cached as negative — un-revoking takes effect immediately", async () => {
  const created = await apiKeysDb.createApiKey("tranche-c-revoke", "machine-revoke");
  assert.ok(created?.key);

  // Sanity: fresh key validates.
  assert.equal(await apiKeysDb.validateApiKey(created.key), true);

  // Revoke + clear caches (revokeApiKey calls invalidateCaches() internally).
  assert.equal(await apiKeysDb.revokeApiKey(created.id), true);
  assert.equal(
    await apiKeysDb.validateApiKey(created.key),
    false,
    "revoked key validates to false"
  );

  // Re-activate via direct SQLite UPDATE to bypass invalidateCaches()
  // (revokeApiKey clears caches; we want to prove the rejection above did
  // NOT cache `{valid: false}` against the hashed key).
  const db = core.getDbInstance();
  db.prepare("UPDATE api_keys SET revoked_at = NULL, is_active = 1 WHERE id = ?").run(created.id);

  // Without negative caching of the revoked-path, the very next call must
  // observe the un-revoked state and return true. If we had cached the
  // revoked rejection, this would still return false (stale negative cache).
  assert.equal(
    await apiKeysDb.validateApiKey(created.key),
    true,
    "un-revoked key must validate immediately — revoked path must not be cached"
  );
});

test("expired keys are NOT cached as negative — extending expiry takes effect immediately", async () => {
  const created = await apiKeysDb.createApiKey("tranche-c-expire", "machine-expire");
  assert.ok(created?.key);

  // Push expiry into the past.
  const past = new Date(Date.now() - 60_000).toISOString();
  assert.equal(await apiKeysDb.setApiKeyExpiry(created.id, past), true);
  assert.equal(await apiKeysDb.validateApiKey(created.key), false);

  // Push expiry forward via raw SQL (bypassing invalidateCaches in
  // setApiKeyExpiry so we test the "no negative cache on expiry path"
  // contract specifically).
  const future = new Date(Date.now() + 60 * 60_000).toISOString();
  const db = core.getDbInstance();
  db.prepare("UPDATE api_keys SET expires_at = ? WHERE id = ?").run(future, created.id);

  assert.equal(
    await apiKeysDb.validateApiKey(created.key),
    true,
    "extending expiry must validate immediately — expired path must not be cached"
  );
});

test("banned keys are NOT cached as negative — un-banning takes effect immediately", async () => {
  const created = await apiKeysDb.createApiKey("tranche-c-ban", "machine-ban");
  assert.ok(created?.key);

  // Mark banned via direct SQLite (no public ban helper exists).
  const db = core.getDbInstance();
  db.prepare("UPDATE api_keys SET is_banned = 1 WHERE id = ?").run(created.id);
  // Clear caches so the test starts from a clean validation state.
  apiKeysDb.clearApiKeyCaches();

  assert.equal(await apiKeysDb.validateApiKey(created.key), false, "banned key validates to false");

  // Un-ban via raw SQL (bypassing any cache invalidator) and immediately re-validate.
  db.prepare("UPDATE api_keys SET is_banned = 0 WHERE id = ?").run(created.id);

  assert.equal(
    await apiKeysDb.validateApiKey(created.key),
    true,
    "un-banned key must validate immediately — banned path must not be cached"
  );
});
