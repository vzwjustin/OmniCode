/**
 * User-supplied upstream extra headers: names we never forward (Host / hop-by-hop / framing).
 * Changing this list requires syncing: `sanitizeUpstreamHeadersMap` (models.ts), Zod
 * `upstreamHeaderNameSchema` / record refine (schemas.ts), and `upstream-headers-sanitize` tests.
 */
const FORBIDDEN = new Set(
  [
    // Hop-by-hop / framing — must never be forwarded.
    "host",
    "connection",
    "content-length",
    "keep-alive",
    "proxy-connection",
    "transfer-encoding",
    "te",
    "trailer",
    "upgrade",
    // Authentication / credential headers — user-supplied extras must never
    // override or leak the proxy's own upstream auth or session state.
    "authorization",
    "cookie",
    "set-cookie",
    "proxy-authorization",
    "x-api-key",
    // CSRF / CORS reference headers — forwarding can confuse upstream origin
    // checks and trick logs into attributing requests to the wrong origin.
    "origin",
    "referer",
    // Client-IP spoofing — never let a user-configured header rewrite the
    // upstream's view of the caller's IP.
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-real-ip",
    "forwarded",
    "cf-connecting-ip",
  ].map((s) => s.toLowerCase())
);

export function isForbiddenUpstreamHeaderName(name: string): boolean {
  return FORBIDDEN.has(String(name).trim().toLowerCase());
}
