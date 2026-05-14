/**
 * User-supplied upstream extra headers: names we never forward (Host / hop-by-hop / framing).
 * Changing this list requires syncing: `sanitizeUpstreamHeadersMap` (models.ts), Zod
 * `upstreamHeaderNameSchema` / record refine (schemas.ts), and `upstream-headers-sanitize` tests.
 */
const FORBIDDEN = new Set(
  [
    "host",
    "connection",
    "content-length",
    "keep-alive",
    "proxy-connection",
    "transfer-encoding",
    "te",
    "trailer",
    "upgrade",
  ].map((s) => s.toLowerCase())
);

export function isForbiddenUpstreamHeaderName(name: string): boolean {
  return FORBIDDEN.has(String(name).trim().toLowerCase());
}

/**
 * Upstream **response** headers we never forward to the client.
 *
 * Critical: `content-encoding` + `content-length` must be stripped because
 * Node's `fetch` (undici) transparently decompresses gzip / br / deflate
 * response bodies. Forwarding the upstream's `Content-Encoding: gzip` header
 * with a now-decompressed body causes the client to emit `ZlibError` trying
 * to gunzip plain text. The remaining names are RFC 7230 hop-by-hop headers
 * which must not be propagated across a proxy hop.
 *
 * The set deliberately overlaps with the request-side `FORBIDDEN` set but is
 * tracked separately so request/response semantics can diverge in the future
 * without breaking either path.
 */
const FORBIDDEN_RESPONSE = new Set(
  [
    "content-encoding",
    "content-length",
    "transfer-encoding",
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "upgrade",
  ].map((s) => s.toLowerCase())
);

export function isForbiddenUpstreamResponseHeaderName(name: string): boolean {
  return FORBIDDEN_RESPONSE.has(String(name).trim().toLowerCase());
}

/**
 * Return a **new** `Headers` instance with hop-by-hop and decompression-leak
 * headers removed. Safe to call on streaming and non-streaming responses.
 * The input `Headers` is not mutated.
 *
 * Use this at every site where an upstream `Response.headers` is being copied
 * into a Response that ultimately reaches the client.
 */
export function sanitizeUpstreamResponseHeaders(headers: Headers): Headers {
  const out = new Headers();
  headers.forEach((value, name) => {
    if (!isForbiddenUpstreamResponseHeaderName(name)) {
      out.append(name, value);
    }
  });
  return out;
}
