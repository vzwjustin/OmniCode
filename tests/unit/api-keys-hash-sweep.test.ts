/**
 * Regression test for the api_keys hash-sweep that runs on every boot.
 *
 * This test exists to catch the 2026-05-14 incident:
 *   - Migration 073_api_keys_hash_only.sql (originally 056, renumbered
 *     during the 2026-05-28 upstream sync) was silently skipped on every
 *     existing deployment because version slot 056 had previously been
 *     applied with a different name (usage_history_observability_columns).
 *   - The version-only "already applied" check then short-circuited the
 *     dispatch and any plaintext api_keys row never got its key_hash
 *     back-filled.
 *   - After Tranche A6.b made validation hash-only, those rows stopped
 *     authenticating and every Claude Code request returned 401, which
 *     the client treats as a retryable error (`Retrying in Xs · attempt
 *     N/10`).
 *
 * The fix is `runApiKeysHashSweep`: an idempotent, table-guarded sweep
 * that hashes every plaintext row regardless of migration tracking state.
 * It runs in both branches of `runMigrations()` (pending=0 short-circuit
 * AND post-migration hook).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { runApiKeysHashSweep } from "../../src/lib/db/migrationRunner.ts";

function makeApiKeysTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE api_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      key TEXT,
      created_at TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      no_log INTEGER NOT NULL DEFAULT 0,
      max_sessions INTEGER NOT NULL DEFAULT 0,
      key_hash TEXT
    );
  `);
}

function expectedHash(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

test("runApiKeysHashSweep: returns 0 when api_keys table does not exist", () => {
  const db = new Database(":memory:");
  assert.equal(runApiKeysHashSweep(db), 0);
});

test("runApiKeysHashSweep: ALTERs to add key_hash column when missing", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE api_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      key TEXT,
      created_at TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1
    );
  `);

  db.prepare(
    "INSERT INTO api_keys (id, name, key, created_at) VALUES ('k1', 'Claude', 'sk-abc', '2026-05-14')"
  ).run();

  const migrated = runApiKeysHashSweep(db);
  assert.equal(migrated, 1);

  const row = db.prepare("SELECT key_hash, key FROM api_keys WHERE id = 'k1'").get() as {
    key_hash: string;
    key: string;
  };
  assert.equal(row.key_hash, expectedHash("sk-abc"));
  // Sweep does NOT NULL the legacy column (per the deferred-step design)
  assert.equal(row.key, "sk-abc");
});

test("runApiKeysHashSweep: back-fills key_hash for rows with plaintext only", () => {
  const db = new Database(":memory:");
  makeApiKeysTable(db);

  const rows = [
    ["k1", "Claude", "sk-aaaa"],
    ["k2", "windsurf", "sk-bbbb"],
    ["k3", "cursor", "sk-cccc"],
  ];
  const ins = db.prepare(
    "INSERT INTO api_keys (id, name, key, created_at) VALUES (?, ?, ?, '2026-05-14')"
  );
  for (const [id, name, key] of rows) ins.run(id, name, key);

  const migrated = runApiKeysHashSweep(db);
  assert.equal(migrated, 3);

  for (const [id, , key] of rows) {
    const r = db.prepare("SELECT key_hash FROM api_keys WHERE id = ?").get(id) as {
      key_hash: string;
    };
    assert.equal(r.key_hash, expectedHash(key));
  }
});

test("runApiKeysHashSweep: skips rows that already have key_hash", () => {
  const db = new Database(":memory:");
  makeApiKeysTable(db);

  db.prepare(
    "INSERT INTO api_keys (id, name, key, key_hash, created_at) VALUES ('k1', 'Already', 'sk-zzz', 'preexisting-hash', '2026-05-14')"
  ).run();

  const migrated = runApiKeysHashSweep(db);
  assert.equal(migrated, 0);

  const row = db.prepare("SELECT key_hash FROM api_keys WHERE id = 'k1'").get() as {
    key_hash: string;
  };
  assert.equal(row.key_hash, "preexisting-hash");
});

test("runApiKeysHashSweep: idempotent on a second invocation", () => {
  const db = new Database(":memory:");
  makeApiKeysTable(db);

  db.prepare(
    "INSERT INTO api_keys (id, name, key, created_at) VALUES ('k1', 'Claude', 'sk-abc', '2026-05-14')"
  ).run();

  assert.equal(runApiKeysHashSweep(db), 1, "first sweep migrates the row");
  assert.equal(runApiKeysHashSweep(db), 0, "second sweep is a no-op");
});

test("runApiKeysHashSweep: empty string key_hash counts as missing", () => {
  const db = new Database(":memory:");
  makeApiKeysTable(db);
  db.prepare(
    "INSERT INTO api_keys (id, name, key, key_hash, created_at) VALUES ('k1', 'Empty', 'sk-yyy', '', '2026-05-14')"
  ).run();

  const migrated = runApiKeysHashSweep(db);
  assert.equal(migrated, 1);

  const row = db.prepare("SELECT key_hash FROM api_keys WHERE id = 'k1'").get() as {
    key_hash: string;
  };
  assert.equal(row.key_hash, expectedHash("sk-yyy"));
});

test("runApiKeysHashSweep: skips rows with empty plaintext key (do not hash '')", () => {
  const db = new Database(":memory:");
  makeApiKeysTable(db);
  db.prepare(
    "INSERT INTO api_keys (id, name, key, created_at) VALUES ('k1', 'Empty', '', '2026-05-14')"
  ).run();

  // Empty plaintext is excluded by the SQL filter (`key IS NOT NULL` matches '')
  // — but the sweep body skips zero-length keys defensively.
  const migrated = runApiKeysHashSweep(db);
  assert.equal(migrated, 0);

  const row = db.prepare("SELECT key_hash FROM api_keys WHERE id = 'k1'").get() as {
    key_hash: string | null;
  };
  assert.ok(!row.key_hash || row.key_hash === "");
});
