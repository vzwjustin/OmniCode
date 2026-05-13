/**
 * In-memory JWT revocation registry.
 *
 * Each entry encodes `${jti}:${expiresAtUnixMs}`. When `denyJti` is called we
 * record the deny entry and lazily prune entries whose `expiresAt` has elapsed.
 *
 * TODO: For multi-process deployments this registry must be DB-backed (e.g. an
 * `auth_revoked_sessions` table with a periodic cleanup job). In-memory state
 * does not survive restarts or replicate across instances. The current
 * single-process implementation is acceptable for the standalone OmniRoute
 * server, but should be replaced before horizontally scaling out.
 */

const denied = new Set<string>();
let lastClean = 0;

export function denyJti(jti: string, expiresAt: number): void {
  if (typeof jti !== "string" || jti.length === 0) return;
  if (!Number.isFinite(expiresAt)) return;
  denied.add(`${jti}:${expiresAt}`);

  // Clean expired entries lazily (at most once per minute).
  const now = Date.now();
  if (now - lastClean > 60_000) {
    for (const entry of denied) {
      const [, exp] = entry.split(":");
      if (Number(exp) < now) denied.delete(entry);
    }
    lastClean = now;
  }
}

export function isJtiDenied(jti: string | undefined | null): boolean {
  if (typeof jti !== "string" || jti.length === 0) return false;
  const prefix = `${jti}:`;
  for (const entry of denied) {
    if (entry.startsWith(prefix)) return true;
  }
  return false;
}

/** Test seam — clear the deny set. Do not call from production code. */
export function resetSessionRegistryForTests(): void {
  denied.clear();
  lastClean = 0;
}
