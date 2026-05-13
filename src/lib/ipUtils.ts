import { isIP } from "node:net";

/**
 * T07: Extract the real client IP from X-Forwarded-For header.
 * Skips invalid entries like "unknown" or empty strings.
 * Falls back to remoteAddress if no valid IP found.
 * Ref: sub2api PR #1135
 *
 * @param xForwardedFor - Value of the X-Forwarded-For header (may be CSV)
 * @param remoteAddress - Fallback from the raw socket (req.socket.remoteAddress)
 * @returns The first valid IP address found, or "unknown"
 */
export function extractClientIp(
  xForwardedFor: string | null | undefined,
  remoteAddress: string | undefined
): string {
  if (xForwardedFor) {
    const entries = xForwardedFor.split(",");
    for (const entry of entries) {
      const trimmed = entry.trim();
      if (trimmed && isIP(trimmed) !== 0) {
        return trimmed; // First valid IP wins
      }
    }
  }
  return remoteAddress?.trim() ?? "unknown";
}

/**
 * Parse `TRUST_PROXY_FROM` (comma-separated CIDRs/IPs). Returns the list of
 * raw entries; matching is performed by `remoteAddressMatchesTrustedProxy`.
 */
function getTrustedProxyEntries(): string[] {
  const raw = process.env.TRUST_PROXY_FROM;
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Convert an IPv4 string to a 32-bit integer, or null if invalid.
 */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    result = (result << 8) + n;
  }
  // Force unsigned 32-bit
  return result >>> 0;
}

/**
 * Test if `remote` matches a trusted proxy CIDR/IP entry. Supports IPv4 CIDRs
 * (`10.0.0.0/8`) and bare IPs (any family — exact string match). Best-effort:
 * IPv6 CIDRs are not currently expanded, only exact-string matched.
 */
function remoteMatchesEntry(remote: string, entry: string): boolean {
  if (!remote) return false;
  if (entry === remote) return true;
  const slash = entry.indexOf("/");
  if (slash === -1) return false;
  const base = entry.slice(0, slash);
  const bitsRaw = Number(entry.slice(slash + 1));
  if (!Number.isFinite(bitsRaw)) return false;

  if (isIP(remote) === 4 && isIP(base) === 4) {
    const bits = Math.min(32, Math.max(0, bitsRaw));
    const a = ipv4ToInt(remote);
    const b = ipv4ToInt(base);
    if (a === null || b === null) return false;
    if (bits === 0) return true;
    const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
    return (a & mask) === (b & mask);
  }
  // IPv6 CIDR: only exact-base match (best-effort).
  return false;
}

function remoteAddressMatchesTrustedProxy(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  const remote = remoteAddress.trim();
  if (!remote) return false;
  const entries = getTrustedProxyEntries();
  if (entries.length === 0) return false;
  return entries.some((entry) => remoteMatchesEntry(remote, entry));
}

/**
 * Whether the runtime is configured to trust upstream proxy headers
 * (`X-Forwarded-For`, `X-Real-IP`, `CF-Connecting-IP`).
 *
 * By default we DO NOT trust them — these headers are trivially spoofable by
 * any client that can reach the server directly. Honor them only when the
 * operator explicitly opts in via env:
 *
 *   - `TRUST_PROXY_HEADERS=true` — trust unconditionally (e.g. behind a fixed
 *     reverse proxy on a private network).
 *   - `TRUST_PROXY_FROM=<csv of CIDRs>` — trust only when the socket peer
 *     matches one of the listed CIDRs.
 */
function shouldTrustProxyHeaders(remoteAddress: string | undefined): boolean {
  if (process.env.TRUST_PROXY_HEADERS === "true") return true;
  return remoteAddressMatchesTrustedProxy(remoteAddress);
}

/**
 * Extract client IP from a Request or NextRequest object.
 * Checks X-Forwarded-For, X-Real-IP, CF-Connecting-IP, then socket — but only
 * when the runtime is configured to trust the upstream proxy (see
 * `shouldTrustProxyHeaders`). When proxy headers are not trusted we fall back
 * to the raw socket remote address.
 */
export function getClientIpFromRequest(req: {
  headers?: Headers | { get?: (n: string) => string | null };
  socket?: { remoteAddress?: string };
  ip?: string;
}): string {
  // Helper to get header value from either Headers object or plain object
  const getHeader = (name: string): string | null => {
    if (!req.headers) return null;
    if (typeof (req.headers as Headers).get === "function") {
      return (req.headers as Headers).get(name);
    }
    return null;
  };

  const remoteAddress = req.ip ?? req.socket?.remoteAddress;

  if (!shouldTrustProxyHeaders(remoteAddress)) {
    // Untrusted: never let arbitrary clients spoof their IP via headers.
    return remoteAddress?.trim() ?? "unknown";
  }

  // Priority: CF-Connecting-IP (Cloudflare) > X-Forwarded-For > X-Real-IP > socket
  const cfIp = getHeader("cf-connecting-ip");
  if (cfIp && isIP(cfIp.trim()) !== 0) return cfIp.trim();

  const xff = getHeader("x-forwarded-for");
  const realIp = getHeader("x-real-ip");

  return extractClientIp(xff ?? realIp, remoteAddress);
}
