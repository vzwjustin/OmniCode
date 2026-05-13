/**
 * Login brute-force guard.
 *
 * Tracks failed `/api/auth/login` attempts per client IP in process memory
 * and returns lockout decisions. Single-process scope is intentional — this
 * is a defense-in-depth check that pairs with Cloudflare/reverse-proxy rate
 * limiting, not a substitute for it.
 *
 * Tunables:
 *   - failure threshold: 5 within `WINDOW_MS`
 *   - lockout duration: `LOCKOUT_MS`
 *   - sliding window: `WINDOW_MS`
 *
 * In addition to the per-IP tracker we keep an UNBUCKETED global counter so a
 * distributed brute-force attack across many IPs cannot fly under the per-IP
 * threshold. Global counter defaults: 30 failures within 5 minutes globally.
 * Tunable via env:
 *   - `LOGIN_GUARD_GLOBAL_THRESHOLD` (default 30)
 *   - `LOGIN_GUARD_GLOBAL_WINDOW_SECONDS` (default 300)
 *   - `LOGIN_GUARD_GLOBAL_LOCKOUT_SECONDS` (default 300)
 *
 * The guard is a no-op when `enabled` is false; the caller decides based on
 * the `bruteForceProtection` setting (default true).
 */

const WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;
const FAILURE_THRESHOLD = 5;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function globalThreshold(): number {
  return envInt("LOGIN_GUARD_GLOBAL_THRESHOLD", 30);
}

function globalWindowMs(): number {
  return envInt("LOGIN_GUARD_GLOBAL_WINDOW_SECONDS", 300) * 1000;
}

function globalLockoutMs(): number {
  return envInt("LOGIN_GUARD_GLOBAL_LOCKOUT_SECONDS", 300) * 1000;
}

interface AttemptState {
  count: number;
  firstAttemptAt: number;
  lockedUntil: number | null;
}

const attempts: Map<string, AttemptState> = new Map();
const globalState: AttemptState = {
  count: 0,
  firstAttemptAt: 0,
  lockedUntil: null,
};

export interface GuardDecision {
  allowed: boolean;
  retryAfterSeconds?: number;
}

function nowMs(): number {
  return Date.now();
}

function clientKey(rawIp: string | null | undefined): string {
  const ip = (rawIp || "").trim();
  return ip || "__unknown__";
}

function checkGlobalLock(now: number): GuardDecision | null {
  if (globalState.lockedUntil && globalState.lockedUntil > now) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((globalState.lockedUntil - now) / 1000),
    };
  }
  return null;
}

export function checkLoginGuard(
  rawIp: string | null | undefined,
  options: { enabled: boolean }
): GuardDecision {
  if (!options.enabled) return { allowed: true };
  const now = nowMs();
  const globalLock = checkGlobalLock(now);
  if (globalLock) return globalLock;
  const state = attempts.get(clientKey(rawIp));
  if (!state) return { allowed: true };
  if (state.lockedUntil && state.lockedUntil > now) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((state.lockedUntil - now) / 1000),
    };
  }
  return { allowed: true };
}

function recordGlobalFailure(now: number): GuardDecision {
  const windowMs = globalWindowMs();
  if (globalState.firstAttemptAt === 0 || now - globalState.firstAttemptAt > windowMs) {
    globalState.count = 1;
    globalState.firstAttemptAt = now;
    globalState.lockedUntil = null;
    return { allowed: true };
  }
  globalState.count += 1;
  const threshold = globalThreshold();
  if (globalState.count >= threshold) {
    const lockMs = globalLockoutMs();
    globalState.lockedUntil = now + lockMs;
    return { allowed: false, retryAfterSeconds: Math.ceil(lockMs / 1000) };
  }
  return { allowed: true };
}

export function recordLoginFailure(
  rawIp: string | null | undefined,
  options: { enabled: boolean }
): GuardDecision {
  if (!options.enabled) return { allowed: true };
  const key = clientKey(rawIp);
  const now = nowMs();
  const existing = attempts.get(key);

  // Update the global (unbucketed) counter on every failure so a distributed
  // attack cannot stay under each IP's threshold.
  const globalDecision = recordGlobalFailure(now);

  if (!existing || now - existing.firstAttemptAt > WINDOW_MS) {
    attempts.set(key, { count: 1, firstAttemptAt: now, lockedUntil: null });
    return globalDecision.allowed ? { allowed: true } : globalDecision;
  }

  const nextCount = existing.count + 1;
  if (nextCount >= FAILURE_THRESHOLD) {
    const lockedUntil = now + LOCKOUT_MS;
    attempts.set(key, {
      count: nextCount,
      firstAttemptAt: existing.firstAttemptAt,
      lockedUntil,
    });
    if (!globalDecision.allowed) return globalDecision;
    return { allowed: false, retryAfterSeconds: Math.ceil(LOCKOUT_MS / 1000) };
  }

  attempts.set(key, {
    count: nextCount,
    firstAttemptAt: existing.firstAttemptAt,
    lockedUntil: null,
  });
  return globalDecision.allowed ? { allowed: true } : globalDecision;
}

export function clearLoginAttempts(rawIp: string | null | undefined): void {
  attempts.delete(clientKey(rawIp));
}

export function resetLoginGuardForTests(): void {
  attempts.clear();
  globalState.count = 0;
  globalState.firstAttemptAt = 0;
  globalState.lockedUntil = null;
}

export const LOGIN_GUARD_TUNABLES = Object.freeze({
  WINDOW_MS,
  LOCKOUT_MS,
  FAILURE_THRESHOLD,
});
