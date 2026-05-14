/**
 * In-memory multi-window rate limiter.
 *
 * Redis was removed in 3.8.x — OmniRoute is a single-instance application
 * (SQLite + in-memory caches). Multi-process / multi-machine rate limiting
 * isn't a goal of this project.
 *
 * If you need distributed rate limiting in the future, reintroduce the Redis
 * client behind a feature flag in this file; the public API of this module
 * (`checkRateLimit`, `setRateLimiterTestMode`) must stay stable so callers
 * don't need to change.
 */

export interface RateLimitRule {
  limit: number;
  window: number; // in seconds
}

export interface RateLimitResult {
  allowed: boolean;
  failedWindow?: number;
}

/**
 * Backwards-compatible no-op shim for callers that previously expected a
 * Redis client. Always returns `null`; new code should not call this — use
 * the cache helpers in `db/apiKeys.ts` instead.
 *
 * @deprecated Redis support was removed. Returns `null`.
 */
export function getRedisClient(): null {
  return null;
}

/**
 * In-memory rate-limit window store.
 *
 * Counts are kept per-process — single-instance only. Window keys carry a
 * TTL via `MEMORY_STORE_EXPIRY`; expired entries are GC'd opportunistically
 * on read.
 */
const MEMORY_STORE = new Map<string, number>();
const MEMORY_STORE_EXPIRY = new Map<string, number>();

let explicitTestMode = false;

export function setRateLimiterTestMode(enabled: boolean) {
  explicitTestMode = enabled;
  if (enabled) {
    MEMORY_STORE.clear();
    MEMORY_STORE_EXPIRY.clear();
  }
}

function gcExpired(now: number) {
  if (MEMORY_STORE_EXPIRY.size <= 256) return;
  for (const [k, expiresAt] of MEMORY_STORE_EXPIRY) {
    if (expiresAt <= now) {
      MEMORY_STORE.delete(k);
      MEMORY_STORE_EXPIRY.delete(k);
    }
  }
}

function evaluateInMemory(keyId: string, rules: RateLimitRule[]): RateLimitResult {
  const now = Math.floor(Date.now() / 1000);
  gcExpired(now);

  // First pass: check if any limit is exceeded.
  for (const rule of rules) {
    const currentWindow = Math.floor(now / rule.window);
    const windowKey = `rl:api_key:${keyId}:${rule.window}:${currentWindow}`;
    const count = MEMORY_STORE.get(windowKey) || 0;
    if (count >= rule.limit) {
      return { allowed: false, failedWindow: rule.window };
    }
  }

  // Second pass: increment every rule's counter and set TTL once.
  for (const rule of rules) {
    const currentWindow = Math.floor(now / rule.window);
    const windowKey = `rl:api_key:${keyId}:${rule.window}:${currentWindow}`;
    MEMORY_STORE.set(windowKey, (MEMORY_STORE.get(windowKey) || 0) + 1);
    if (!MEMORY_STORE_EXPIRY.has(windowKey)) {
      MEMORY_STORE_EXPIRY.set(windowKey, now + rule.window * 2);
    }
  }
  return { allowed: true };
}

/**
 * Checks multi-window rate limits for an API key.
 *
 * `setRateLimiterTestMode(true)` and `NODE_ENV=test` keep the same code path
 * (in-memory) as production — the only difference in tests is that the store
 * is reset between cases.
 */
export async function checkRateLimit(
  keyId: string,
  rules: RateLimitRule[]
): Promise<RateLimitResult> {
  if (!rules || rules.length === 0) return { allowed: true };
  void explicitTestMode; // referenced so the test-mode setter has observable side effects
  return evaluateInMemory(keyId, rules);
}
