import bcrypt from "bcryptjs";
import { getSettings, updateSettings } from "@/lib/db/settings";

const BCRYPT_HASH_PATTERN = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;
// Bcrypt cost factor; env-overridable. 14 ≈ 1.5s/hash on modern CPUs and is
// our preferred default. Allow 10..15 to avoid pathologically slow logins or
// trivially weak hashes from misconfiguration.
function resolveBcryptCost(): number {
  const raw = process.env.OMNIROUTE_BCRYPT_COST;
  const parsed = raw ? Number.parseInt(raw, 10) : 14;
  if (!Number.isFinite(parsed) || parsed < 10 || parsed > 15) return 14;
  return parsed;
}
const MANAGEMENT_PASSWORD_SALT_ROUNDS = resolveBcryptCost();

type JsonRecord = Record<string, unknown>;

type MigrationSource = "stored_hash" | "stored_plaintext" | "env" | "missing";

interface EnsureManagementPasswordOptions {
  initialPassword?: string | null;
  logger?: Pick<Console, "log">;
  settings?: JsonRecord;
  source?: string;
}

export interface EnsuredManagementPassword {
  hash: string | null;
  migrated: boolean;
  settings: JsonRecord;
  source: MigrationSource;
}

function getInitialPasswordValue(value: string | null | undefined) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function getStoredManagementPassword(settings: JsonRecord | null | undefined) {
  return typeof settings?.password === "string" ? settings.password : "";
}

/**
 * Whether the persisted password is a bootstrap credential (e.g. migrated
 * from `INITIAL_PASSWORD`) that the operator MUST rotate before being granted
 * a real session. See `ensurePersistentManagementPasswordHash`, which sets
 * this flag whenever the persisted hash was derived from env or any other
 * non-user-chosen source.
 */
export function isPasswordMustRotate(settings: JsonRecord | null | undefined): boolean {
  return settings?.passwordMustRotate === true;
}

export function hasManagementPasswordConfigured(settings: JsonRecord | null | undefined) {
  return (
    getStoredManagementPassword(settings).length > 0 ||
    getInitialPasswordValue(process.env.INITIAL_PASSWORD) !== null
  );
}

export function isBcryptHash(value: unknown): value is string {
  return typeof value === "string" && BCRYPT_HASH_PATTERN.test(value);
}

export async function hashManagementPassword(password: string) {
  return bcrypt.hash(password, MANAGEMENT_PASSWORD_SALT_ROUNDS);
}

export async function verifyManagementPassword(password: string, hash: string) {
  if (!isBcryptHash(hash)) return false;
  return bcrypt.compare(password, hash);
}

export async function ensurePersistentManagementPasswordHash(
  options: EnsureManagementPasswordOptions = {}
): Promise<EnsuredManagementPassword> {
  const settings = options.settings ?? ((await getSettings()) as JsonRecord);
  const storedPassword = getStoredManagementPassword(settings);

  if (isBcryptHash(storedPassword)) {
    return {
      hash: storedPassword,
      migrated: false,
      settings,
      source: "stored_hash",
    };
  }

  const bootstrapPassword =
    storedPassword ||
    getInitialPasswordValue(options.initialPassword ?? process.env.INITIAL_PASSWORD);

  if (!bootstrapPassword) {
    return {
      hash: null,
      migrated: false,
      settings,
      source: "missing",
    };
  }

  const passwordHash = await hashManagementPassword(bootstrapPassword);
  const updates: JsonRecord = { password: passwordHash };

  if (settings.setupComplete !== true) {
    updates.setupComplete = true;
  }
  if (!storedPassword) {
    updates.requireLogin = true;
  }
  // Mark the hash as a bootstrap credential that must be rotated before a
  // full session is issued. This prevents `INITIAL_PASSWORD` (or a legacy
  // plaintext value persisted in settings) from acting as a permanent
  // backdoor: the operator can still log in once, but must change the
  // password before being granted normal access.
  updates.passwordMustRotate = true;

  const nextSettings = (await updateSettings(updates)) as JsonRecord;
  if (options.logger) {
    const context = options.source ? ` during ${options.source}` : "";
    const migrationSource = storedPassword ? "stored plaintext password" : "INITIAL_PASSWORD";
    options.logger.log(`[AUTH] Migrated ${migrationSource} to bcrypt hash${context}`);
  }

  return {
    hash: getStoredManagementPassword(nextSettings) || passwordHash,
    migrated: true,
    settings: nextSettings,
    source: storedPassword ? "stored_plaintext" : "env",
  };
}
