/**
 * OAuth State Store
 *
 * Server-side store for OAuth `state` parameters to prevent CSRF and
 * cross-provider state confusion attacks (RFC 6749 §10.12 / §10.14).
 *
 * The `state` is generated server-side at `generateAuthData()` time, returned
 * to the client, and then verified — and consumed — at exchange time. Each
 * state is single-use and expires after STATE_TTL_MS (10 minutes).
 *
 * Security intent:
 *   - An attacker who tricks a victim into completing an OAuth flow cannot
 *     reuse or fabricate a state for which the server has no record.
 *   - States are bound to the provider that generated them, so a state issued
 *     for provider A cannot be used to complete an exchange for provider B.
 *   - Entries are deleted immediately after a successful lookup so a replay
 *     attempt with the same state code is rejected.
 */
import crypto from "node:crypto";

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const PRUNE_INTERVAL_MS = 60 * 1000; // 60 seconds

export interface OAuthStateEntry {
  providerId: string;
  codeVerifier: string;
  expiresAt: number;
  sessionFingerprint?: string;
}

// Module-level singleton store. Survives Next.js HMR via globalThis.
declare global {
   
  var __omnirouteOAuthStateStore: Map<string, OAuthStateEntry> | undefined;
   
  var __omnirouteOAuthStatePruneTimer: NodeJS.Timeout | undefined;
}

function getStore(): Map<string, OAuthStateEntry> {
  if (!globalThis.__omnirouteOAuthStateStore) {
    globalThis.__omnirouteOAuthStateStore = new Map();
  }
  return globalThis.__omnirouteOAuthStateStore;
}

/**
 * Generate a new cryptographically-random state value.
 */
export function generateStateValue(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * Record a state entry for later verification.
 * Returns the same state for convenience.
 */
export function recordState(
  state: string,
  entry: Omit<OAuthStateEntry, "expiresAt"> & { expiresAt?: number }
): string {
  const store = getStore();
  store.set(state, {
    providerId: entry.providerId,
    codeVerifier: entry.codeVerifier,
    sessionFingerprint: entry.sessionFingerprint,
    expiresAt: entry.expiresAt ?? Date.now() + STATE_TTL_MS,
  });
  ensurePruneTimer();
  return state;
}

/**
 * Look up and atomically delete a state entry.
 *
 * Returns `null` if the state is missing, expired, or its providerId does not
 * match the expected provider. The caller should reject the request with 400
 * "invalid oauth state" in any of these cases.
 */
export function consumeState(state: string, providerId: string): OAuthStateEntry | null {
  if (!state || typeof state !== "string") return null;

  const store = getStore();
  const entry = store.get(state);
  if (!entry) return null;

  // Single-use: always delete on lookup, regardless of validity.
  store.delete(state);

  if (entry.expiresAt < Date.now()) return null;
  if (entry.providerId !== providerId) return null;

  return entry;
}

/**
 * Remove expired entries. Called on an interval and on-demand from recordState.
 */
export function pruneExpired(now: number = Date.now()): number {
  const store = getStore();
  let removed = 0;
  for (const [state, entry] of store) {
    if (entry.expiresAt < now) {
      store.delete(state);
      removed++;
    }
  }
  return removed;
}

/**
 * Start the prune interval if not already running. Guarded against multiple
 * starts (HMR, repeated module evaluation, tests).
 */
function ensurePruneTimer(): void {
  if (globalThis.__omnirouteOAuthStatePruneTimer) return;
  // In non-Node environments (Edge runtime), setInterval may not return a
  // Timeout object with .unref(); we still call unref() defensively.
  const timer = setInterval(() => {
    try {
      pruneExpired();
    } catch {
      /* ignore */
    }
  }, PRUNE_INTERVAL_MS);
  if (typeof (timer as NodeJS.Timeout).unref === "function") {
    (timer as NodeJS.Timeout).unref();
  }
  globalThis.__omnirouteOAuthStatePruneTimer = timer;
}

/**
 * Test-only: clear the store. Not exported as part of the normal API surface
 * but useful for unit tests.
 */
export function __resetStateStoreForTests(): void {
  getStore().clear();
}
