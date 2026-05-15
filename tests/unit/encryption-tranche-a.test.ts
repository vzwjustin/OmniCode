/**
 * Tranche A — Task D1: unit tests for the Tranche A encryption fixes.
 *
 * Covers:
 *   - Round-trip encrypt/decrypt with the canonical static-salt key produces
 *     a properly-prefixed (`enc:v1:`) ciphertext.
 *   - `encrypt()` THROWS an `EncryptionError` on a forced crypto fault
 *     (Task A1: fail-closed instead of demoting to plaintext-at-rest).
 *   - A legacy dynamic-salt ciphertext decrypts cleanly through the patched
 *     `decrypt()` (Task A2: legacy-salt fallback).
 *   - `migrateLegacyEncryptedString` returns `{ updated: true, value: <re-encrypted> }`
 *     for that same fixture (Task A2 / A3 sweep contract).
 *
 * The test process derives the legacy ciphertext in-line using the SAME
 * key-derivation routine that v3.7.7 used (sha256-of-secret as salt), so we
 * never depend on a checked-in binary fixture.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

const TEST_STORAGE_KEY = "test-key-32-bytes-min-aaaaaaaaaaaaaa";
const ORIGINAL_STORAGE_KEY = process.env.STORAGE_ENCRYPTION_KEY;

async function importFresh(modulePath: string) {
  const url = pathToFileURL(path.resolve(modulePath)).href;
  return import(`${url}?test=${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

/**
 * Produce a ciphertext with the LEGACY dynamic-salt key derivation that
 * v3.7.7 used. Mirrors the helper in tests/unit/db-encryption.test.ts so
 * the two test files stay in lock-step.
 */
function encryptWithLegacyDynamicSalt(secret: string, plaintext: string): string {
  const key = scryptSync(secret, createHash("sha256").update(secret).digest().slice(0, 16), 32);
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return `enc:v1:${iv.toString("hex")}:${encrypted}:${authTag}`;
}

test.before(() => {
  process.env.STORAGE_ENCRYPTION_KEY = TEST_STORAGE_KEY;
});

test.after(() => {
  if (ORIGINAL_STORAGE_KEY === undefined) {
    delete process.env.STORAGE_ENCRYPTION_KEY;
  } else {
    process.env.STORAGE_ENCRYPTION_KEY = ORIGINAL_STORAGE_KEY;
  }
});

test("round-trip with the canonical static-salt key emits the enc:v1 prefix", async () => {
  process.env.STORAGE_ENCRYPTION_KEY = TEST_STORAGE_KEY;
  const encryption = await importFresh("src/lib/db/encryption.ts");

  const ciphertext = encryption.encrypt("plain-secret");
  assert.equal(typeof ciphertext, "string");
  assert.match(ciphertext, /^enc:v1:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);

  const decrypted = encryption.decrypt(ciphertext);
  assert.equal(decrypted, "plain-secret");

  // Double-encrypt MUST be a no-op (already-encrypted detection).
  assert.equal(encryption.encrypt(ciphertext), ciphertext);
});

test("encrypt() THROWS EncryptionError on a forced crypto fault (Task A1)", async (t) => {
  process.env.STORAGE_ENCRYPTION_KEY = TEST_STORAGE_KEY;

  // ESM/tsx destructured imports (`import { createCipheriv } from "node:crypto"`)
  // capture the binding at module load — patching `crypto.createCipheriv` on
  // the namespace AFTER the encryption module has loaded does not propagate.
  // Instead we patch the `update` slot on the Cipher prototype that EVERY
  // cipher instance shares. The encryption module constructs a cipher
  // normally and trips the fault on `.update()`, exercising the same
  // try/catch branch at src/lib/db/encryption.ts:142-156.
  const probe = createCipheriv("aes-256-gcm", Buffer.alloc(32), Buffer.alloc(16));
  const cipherProto = Object.getPrototypeOf(probe);
  t.mock.method(cipherProto, "update", () => {
    throw new Error("simulated crypto fault");
  });

  const encryption = await importFresh("src/lib/db/encryption.ts");

  assert.throws(
    () => encryption.encrypt("would-leak-as-plaintext"),
    (err: unknown) => {
      assert.ok(err instanceof Error, "expected an Error instance");
      assert.equal((err as Error).name, "EncryptionError");
      assert.match((err as Error).message, /Field encryption failed/);
      return true;
    }
  );
});

test("decrypt() succeeds on a legacy dynamic-salt fixture (Task A2)", async () => {
  process.env.STORAGE_ENCRYPTION_KEY = TEST_STORAGE_KEY;
  const encryption = await importFresh("src/lib/db/encryption.ts");

  const legacyCiphertext = encryptWithLegacyDynamicSalt(TEST_STORAGE_KEY, "legacy-token-value");

  // The fixture would have been UNDECRYPTABLE under the static-only key path
  // shipped in v3.7.8. After Task A2 the legacy salt is tried as a fallback
  // and the plaintext is returned.
  const decrypted = encryption.decrypt(legacyCiphertext);
  assert.equal(decrypted, "legacy-token-value");

  // decryptWithMigration exposes the migration flag separately so callers
  // (Task A3 sweep) can decide whether to write the row back.
  const result = encryption.decryptWithMigration(legacyCiphertext);
  assert.equal(result.value, "legacy-token-value");
  assert.equal(result.migrationNeeded, true);
});

test("migrateLegacyEncryptedString re-encrypts a legacy fixture with the canonical key", async () => {
  process.env.STORAGE_ENCRYPTION_KEY = TEST_STORAGE_KEY;
  const encryption = await importFresh("src/lib/db/encryption.ts");

  const legacyCiphertext = encryptWithLegacyDynamicSalt(TEST_STORAGE_KEY, "legacy-provider-token");
  const migrated = encryption.migrateLegacyEncryptedString(legacyCiphertext);

  assert.equal(migrated.updated, true);
  assert.equal(typeof migrated.value, "string");
  assert.match(migrated.value, /^enc:v1:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
  // The migrated value is a NEW ciphertext (different IV at minimum).
  assert.notEqual(migrated.value, legacyCiphertext);
  // And it decrypts under the canonical static-salt path.
  assert.equal(encryption.decrypt(migrated.value), "legacy-provider-token");

  // Idempotency: running the sweep again on the already-canonical ciphertext
  // must be a no-op so the post-migration hook never thrashes the row.
  const reMigrated = encryption.migrateLegacyEncryptedString(migrated.value);
  assert.equal(reMigrated.updated, false);
  assert.equal(reMigrated.value, migrated.value);
});
