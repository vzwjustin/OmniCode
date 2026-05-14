/**
 * Multi-window in-memory rate limiter.
 *
 * Replaces the previous Redis-backed implementation. All counters live in the
 * current Node.js process — OmniRoute persists state in SQLite and keeps hot
 * counters in memory, no external Redis is required (or supported).
 *
 * Algorithm: fixed window per (apiKeyId, windowSizeSeconds). On each request
 * we first check every configured rule, then — only if all pass — increment
 * every counter atomically (single-threaded JS so the two passes can't
 * interleave). Expired windows are evicted lazily during a periodic sweep so
 * the map cannot grow without bound.
 */

export interface RateLimitRule {
  limit: number;
  window: number; // seconds
}

export interface RateLimitResult {
  allowed: boolean;
  failedWindow?: number;
}

interface CounterEntry {
  count: number;
  expiresAtMs: number;
}

const COUNTERS = new Map<string, CounterEntry>();
const CLEANUP_INTERVAL_MS = 60_000;
let _lastSweepMs = 0;
let _explicitTestMode = false;

/**
 * Test hook — clears all in-memory counters. The boolean is retained for
 * backward compatibility with callers that previously toggled a separate
 * test store; behaviour is identical regardless of the flag now.
 */
export function setRateLimiterTestMode(enabled: boolean): void {
  _explicitTestMode = enabled;
  COUNTERS.clear();
  _lastSweepMs = 0;
}

/** Internal helper for tests that need to wipe state without flipping the flag. */
export function __resetRateLimiterStateForTests(): void {
  COUNTERS.clear();
  _lastSweepMs = 0;
}

function sweepExpired(nowMs: number): void {
  if (nowMs - _lastSweepMs < CLEANUP_INTERVAL_MS) return;
  _lastSweepMs = nowMs;
  for (const [key, entry] of COUNTERS) {
    if (entry.expiresAtMs <= nowMs) COUNTERS.delete(key);
  }
}

/**
 * Checks multi-window rate limits for an API key.
 *
 * Returns `{ allowed: true }` when every configured window has capacity,
 * otherwise `{ allowed: false, failedWindow }` identifying which window
 * tripped first. No counters are incremented when the request is rejected.
 */
export async function checkRateLimit(
  keyId: string,
  rules: RateLimitRule[]
): Promise<RateLimitResult> {
  if (!rules || rules.length === 0) return { allowed: true };
  // The flag is referenced so it remains a public surface for the test suite,
  // but behaviour is identical in both modes for this pure in-memory impl.
  void _explicitTestMode;

  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  sweepExpired(nowMs);

  // First pass: verify every rule has room before mutating anything.
  for (const rule of rules) {
    const currentWindow = Math.floor(nowSec / rule.window);
    const windowKey = `rl:api_key:${keyId}:${rule.window}:${currentWindow}`;
    const entry = COUNTERS.get(windowKey);
    const count = entry && entry.expiresAtMs > nowMs ? entry.count : 0;
    if (count >= rule.limit) {
      return { allowed: false, failedWindow: rule.window };
    }
  }

  // Second pass: increment all counters. TTL is twice the window size so the
  // entry safely outlives the active window (matches the original Lua impl).
  for (const rule of rules) {
    const currentWindow = Math.floor(nowSec / rule.window);
    const windowKey = `rl:api_key:${keyId}:${rule.window}:${currentWindow}`;
    const existing = COUNTERS.get(windowKey);
    if (existing && existing.expiresAtMs > nowMs) {
      existing.count += 1;
    } else {
      COUNTERS.set(windowKey, {
        count: 1,
        expiresAtMs: nowMs + rule.window * 2 * 1000,
      });
    }
  }

  return { allowed: true };
}
