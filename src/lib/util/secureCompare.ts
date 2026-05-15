/**
 * Constant-time string comparison helpers (CWE-208).
 *
 * Used to compare secrets (API keys, OAuth state, HMAC tokens) against
 * trusted server-side values without exposing a length-or-prefix timing
 * oracle to the caller.
 *
 * Pattern was previously inlined at
 * src/app/api/oauth/[provider]/[action]/route.ts:49-55; promoted here so
 * Tranche A — Task A5 can apply it from multiple call sites
 * (`src/sse/services/auth.ts:isValidApiKey` and
 * `src/lib/db/apiKeys.ts:isConfiguredEnvApiKey`).
 *
 * IMPORTANT: `crypto.timingSafeEqual` throws when the two Buffers have
 * different lengths. We work around this by:
 *   1. Always allocating two Buffers of the SAME length (the maximum of
 *      both inputs), padding the shorter one with a deterministic
 *      sentinel byte.
 *   2. Running `timingSafeEqual` on those equal-length buffers.
 *   3. AND-ing the result with the boolean "lengths were equal" check.
 *
 * That keeps total work uniform across all length combinations and
 * never leaks the original length via wall-clock cost.
 */

import { timingSafeEqual } from "crypto";

/**
 * Constant-time comparison of two strings. Null/undefined inputs only
 * compare equal to one another. Mixed null/string returns false in O(1).
 */
export function secureCompareStrings(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  if (a == null || b == null) {
    // Both null/undefined => equal; mixed => not equal. No timing leak
    // because both branches are constant work.
    return a === b;
  }
  return secureCompareBuffers(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * Constant-time comparison of two Buffers without throwing on length
 * mismatch. The work performed is `O(max(a.length, b.length))` regardless
 * of where the strings first diverge.
 */
export function secureCompareBuffers(a: Buffer, b: Buffer): boolean {
  const maxLength = Math.max(a.length, b.length, 1);

  // Pad both inputs to the same length with a deterministic byte so
  // timingSafeEqual never throws. The pad byte is 0x00; using a single
  // distinct byte keeps the comparison constant-time for any pair of
  // lengths.
  const paddedA = Buffer.alloc(maxLength, 0);
  const paddedB = Buffer.alloc(maxLength, 0);
  a.copy(paddedA);
  b.copy(paddedB);

  const equalContent = timingSafeEqual(paddedA, paddedB);
  // Length mismatch is a clear "not equal" signal, but we still ran the
  // full timingSafeEqual above so the wall-clock cost is uniform.
  return equalContent && a.length === b.length;
}
