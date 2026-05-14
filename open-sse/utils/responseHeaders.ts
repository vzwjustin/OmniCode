/**
 * responseHeaders.ts — utilities for safely forwarding upstream HTTP response
 * headers to the client.
 *
 * The critical fix here addresses Node's `fetch()` / `undici` behavior:
 * when an upstream server responds with `Content-Encoding: gzip` (or `br` /
 * `deflate` / `zstd`), Node auto-decompresses the response body before
 * exposing it via `response.body` / `response.text()` / `response.json()`.
 *
 * However, the `Content-Encoding` header on the Response object is NOT
 * stripped. If we naively forward upstream headers to the client, the
 * client will see `Content-Encoding: gzip` but receive plain decompressed
 * bytes → it tries to gunzip them → `ZlibError`.
 *
 * Similarly, `Content-Length` becomes wrong after any transform/decompression,
 * and hop-by-hop headers (per RFC 7230 §6.1) must never be proxied.
 *
 * This module centralizes the sanitization so every header-forwarding site
 * uses the same rules.
 */

/**
 * Header names that must be stripped when forwarding an upstream response
 * to the client. Names are lowercased; comparison is case-insensitive.
 *
 * - `content-encoding`: body is already decompressed by Node fetch — keeping
 *   this header causes ZlibError on the client.
 * - `content-length`: may be wrong after decompression / transform stream.
 * - Hop-by-hop headers (RFC 7230): must never be proxied.
 */
const STRIPPED_UPSTREAM_HEADERS = new Set<string>([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "upgrade",
]);

/**
 * Returns a new `Headers` object containing the upstream headers with
 * problematic entries removed. Safe to forward to the client.
 *
 * @param upstream — the upstream `Response.headers` (or any `HeadersInit`)
 * @returns a new `Headers` object suitable for client responses
 */
export function sanitizeUpstreamHeaders(
  upstream: Headers | HeadersInit | null | undefined
): Headers {
  const out = new Headers();
  if (!upstream) return out;
  const src = upstream instanceof Headers ? upstream : new Headers(upstream);
  for (const [key, value] of src.entries()) {
    if (STRIPPED_UPSTREAM_HEADERS.has(key.toLowerCase())) continue;
    out.append(key, value);
  }
  return out;
}

/**
 * In-place mutating version: removes problematic entries from an existing
 * `Headers` object. Useful when callers already built the Headers and just
 * need to strip a few entries.
 *
 * @param headers — the `Headers` object to mutate
 */
export function stripUpstreamHeaderHazards(headers: Headers): void {
  for (const name of STRIPPED_UPSTREAM_HEADERS) {
    if (headers.has(name)) headers.delete(name);
  }
}

/**
 * Test-only export of the strip set. Do not rely on this in production code.
 * @internal
 */
export const __STRIPPED_UPSTREAM_HEADERS_FOR_TESTING = STRIPPED_UPSTREAM_HEADERS;
