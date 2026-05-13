import { getDbInstance } from "./core";
import { decrypt, encrypt, EncryptionKeyMismatchError } from "./encryption";

interface SecretRow {
  value?: string;
}

/**
 * Read a persisted secret from `key_value` (`namespace = 'secrets'`).
 *
 * Values are stored as JSON-encoded strings of the (optionally) encrypted secret.
 * Older rows may contain plaintext JSON, in which case `decrypt()` returns the
 * value unchanged (legacy plaintext passthrough). New rows are wrapped via
 * `encrypt()` and round-trip transparently here.
 *
 * NOTE: If STORAGE_ENCRYPTION_KEY changes between writes and reads, decrypt
 * will fail and this function returns null. Operators rotating the encryption
 * key must also rotate (or re-persist) any secrets stored here.
 */
export function getPersistedSecret(key: string): string | null {
  try {
    const db = getDbInstance();
    const row = db
      .prepare("SELECT value FROM key_value WHERE namespace = 'secrets' AND key = ?")
      .get(key) as SecretRow | undefined;
    if (typeof row?.value !== "string") return null;
    let stored: unknown;
    try {
      stored = JSON.parse(row.value);
    } catch {
      return null;
    }
    if (typeof stored !== "string") return null;
    try {
      const decrypted = decrypt(stored);
      return typeof decrypted === "string" ? decrypted : null;
    } catch (err: unknown) {
      if (err instanceof EncryptionKeyMismatchError) {
        console.error(
          `[Secrets] Failed to decrypt persisted secret "${key}": likely STORAGE_ENCRYPTION_KEY mismatch.`
        );
        return null;
      }
      throw err;
    }
  } catch {
    return null;
  }
}

/**
 * Persist a secret value under `namespace = 'secrets'`.
 *
 * The value is encrypted via `encrypt()` before being JSON-stringified into
 * `key_value.value`. If STORAGE_ENCRYPTION_KEY is unset and the runtime allows
 * plaintext (development or `OMNIROUTE_ALLOW_PLAINTEXT_STORAGE=true`), the
 * value falls through to plaintext.
 *
 * NOTE: Uses INSERT OR IGNORE to preserve the original generated secret across
 * restarts. To rotate, callers must explicitly delete the existing row first.
 */
export function persistSecret(key: string, value: string): void {
  try {
    const db = getDbInstance();
    const encrypted = encrypt(value);
    const serialized = JSON.stringify(typeof encrypted === "string" ? encrypted : value);
    db.prepare(
      "INSERT OR IGNORE INTO key_value (namespace, key, value) VALUES ('secrets', ?, ?)"
    ).run(key, serialized);
  } catch {
    // Non-fatal: secrets still work for the current process if persistence fails.
  }
}
