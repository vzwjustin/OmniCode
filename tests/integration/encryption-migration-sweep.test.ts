/**
 * Tranche A — Task A3 integration test: verify the post-migration legacy-
 * encryption sweep actually re-encrypts rows whose ciphertext fields were
 * produced with the v3.7.7 dynamic-salt key derivation.
 *
 * The test:
 *   1. Spins up a fresh temp SQLite DB via better-sqlite3 (no global state).
 *   2. Creates a minimal `provider_connections` table.
 *   3. Inserts a row with `access_token` and `refresh_token` encrypted under
 *      the LEGACY dynamic-salt derivation (computed in-test from the same
 *      `STORAGE_ENCRYPTION_KEY` the encryption module reads).
 *   4. Calls `runLegacyEncryptionSweep(db)` from `src/lib/db/migrationRunner.ts`.
 *   5. Asserts both columns are now re-encrypted (different IV, same
 *      `enc:v1:` prefix) AND decrypt cleanly via `decrypt()`.
 *   6. Cleans up the temp DB file on teardown.
 *
 * Closes recent_issues.jsonl #9 verifiability requirement in the plan's
 * Verification Criteria section.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import Database from "better-sqlite3";

const TEST_STORAGE_KEY = "tranche-a-integration-key-min-aaaaaaaaaa";
const ORIGINAL_STORAGE_KEY = process.env.STORAGE_ENCRYPTION_KEY;

process.env.STORAGE_ENCRYPTION_KEY = TEST_STORAGE_KEY;

// IMPORTANT: import the production modules AFTER the env var is set so the
// static-salt key derivation captures the right secret.
const { runLegacyEncryptionSweep } = await import("../../src/lib/db/migrationRunner.ts");
const { decrypt, isEncryptionEnabled } = await import("../../src/lib/db/encryption.ts");

function encryptWithLegacyDynamicSalt(secret: string, plaintext: string): string {
  const key = scryptSync(secret, createHash("sha256").update(secret).digest().slice(0, 16), 32);
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return `enc:v1:${iv.toString("hex")}:${encrypted}:${authTag}`;
}

function createTempDb(): { db: InstanceType<typeof Database>; filePath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-sweep-it-"));
  const filePath = path.join(dir, "test.sqlite");
  const db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  return { db, filePath };
}

function setupProviderConnectionsSchema(db: InstanceType<typeof Database>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_connections (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      api_key TEXT,
      access_token TEXT,
      refresh_token TEXT,
      id_token TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

test.after(() => {
  if (ORIGINAL_STORAGE_KEY === undefined) {
    delete process.env.STORAGE_ENCRYPTION_KEY;
  } else {
    process.env.STORAGE_ENCRYPTION_KEY = ORIGINAL_STORAGE_KEY;
  }
});

test("runLegacyEncryptionSweep re-encrypts legacy-salt provider_connections rows", () => {
  assert.equal(
    isEncryptionEnabled(),
    true,
    "test harness must run with STORAGE_ENCRYPTION_KEY set"
  );

  const { db, filePath } = createTempDb();

  try {
    setupProviderConnectionsSchema(db);

    const legacyAccess = encryptWithLegacyDynamicSalt(TEST_STORAGE_KEY, "legacy-access-token");
    const legacyRefresh = encryptWithLegacyDynamicSalt(TEST_STORAGE_KEY, "legacy-refresh-token");

    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO provider_connections (id, provider, access_token, refresh_token, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?)"
    ).run("conn-legacy", "openai", legacyAccess, legacyRefresh, now, now);

    // Sanity: rows currently store the legacy ciphertext.
    const before = db
      .prepare("SELECT access_token, refresh_token FROM provider_connections WHERE id = ?")
      .get("conn-legacy") as { access_token: string; refresh_token: string };
    assert.equal(before.access_token, legacyAccess);
    assert.equal(before.refresh_token, legacyRefresh);

    // ── Invoke the post-migration sweep wired by Task A3 ──
    const migrated = runLegacyEncryptionSweep(db);
    assert.ok(migrated >= 1, `expected at least one row to be migrated, got ${migrated}`);

    // ── Assert the columns were rewritten ──
    const after = db
      .prepare("SELECT access_token, refresh_token FROM provider_connections WHERE id = ?")
      .get("conn-legacy") as { access_token: string; refresh_token: string };

    assert.notEqual(
      after.access_token,
      legacyAccess,
      "access_token must be re-encrypted with a fresh IV under the static-salt key"
    );
    assert.notEqual(
      after.refresh_token,
      legacyRefresh,
      "refresh_token must be re-encrypted with a fresh IV under the static-salt key"
    );

    assert.match(after.access_token, /^enc:v1:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
    assert.match(after.refresh_token, /^enc:v1:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);

    // ── Assert the new ciphertexts decrypt cleanly with the canonical key ──
    assert.equal(decrypt(after.access_token), "legacy-access-token");
    assert.equal(decrypt(after.refresh_token), "legacy-refresh-token");

    // ── Idempotency: re-running the sweep does nothing ──
    const reSweep = runLegacyEncryptionSweep(db);
    assert.equal(reSweep, 0, "second sweep on already-migrated rows must be a no-op");
  } finally {
    db.close();
    // Best-effort cleanup of the temp DB and its parent dir.
    try {
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});
