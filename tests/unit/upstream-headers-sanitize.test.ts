import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeUpstreamHeadersMap } from "../../src/lib/db/models.ts";
import {
  isForbiddenUpstreamResponseHeaderName,
  sanitizeUpstreamResponseHeaders,
} from "../../src/shared/constants/upstreamHeaders.ts";

test("sanitizeUpstreamHeadersMap: drops hop-by-hop / Host names", () => {
  const out = sanitizeUpstreamHeadersMap({
    Host: "evil",
    Connection: "close",
    "Content-Length": "999",
    "X-Custom": "ok",
  });
  assert.deepEqual(out, { "X-Custom": "ok" });
});

test("sanitizeUpstreamHeadersMap: drops values with CR/LF", () => {
  const out = sanitizeUpstreamHeadersMap({
    Good: "a",
    Bad: "x\ny",
    Bad2: "x\ry",
  });
  assert.deepEqual(out, { Good: "a" });
});

test("sanitizeUpstreamHeadersMap: caps count at 16", () => {
  const raw = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`H${i}`, String(i)]));
  const out = sanitizeUpstreamHeadersMap(raw);
  assert.strictEqual(Object.keys(out).length, 16);
});

test("isForbiddenUpstreamResponseHeaderName: flags content-encoding (ZlibError root cause)", () => {
  assert.equal(isForbiddenUpstreamResponseHeaderName("content-encoding"), true);
  assert.equal(isForbiddenUpstreamResponseHeaderName("Content-Encoding"), true);
  assert.equal(isForbiddenUpstreamResponseHeaderName("  CONTENT-ENCODING  "), true);
});

test("isForbiddenUpstreamResponseHeaderName: flags content-length", () => {
  assert.equal(isForbiddenUpstreamResponseHeaderName("content-length"), true);
  assert.equal(isForbiddenUpstreamResponseHeaderName("Content-Length"), true);
});

test("isForbiddenUpstreamResponseHeaderName: flags all RFC 7230 hop-by-hop headers", () => {
  const hopByHop = [
    "connection",
    "keep-alive",
    "transfer-encoding",
    "te",
    "trailer",
    "upgrade",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
  ];
  for (const name of hopByHop) {
    assert.equal(isForbiddenUpstreamResponseHeaderName(name), true, `${name} must be forbidden`);
    assert.equal(
      isForbiddenUpstreamResponseHeaderName(name.toUpperCase()),
      true,
      `${name.toUpperCase()} (case-insensitive) must be forbidden`
    );
  }
});

test("isForbiddenUpstreamResponseHeaderName: lets through benign headers", () => {
  for (const name of [
    "content-type",
    "cache-control",
    "x-request-id",
    "anthropic-ratelimit-requests-remaining",
    "retry-after",
    "x-omniroute-cache",
    "etag",
  ]) {
    assert.equal(isForbiddenUpstreamResponseHeaderName(name), false, `${name} must pass through`);
  }
});

test("sanitizeUpstreamResponseHeaders: strips Content-Encoding (gzip) but keeps other headers", () => {
  const upstream = new Headers({
    "content-encoding": "gzip",
    "content-length": "12345",
    "content-type": "application/json",
    "x-request-id": "req_abc",
    "anthropic-ratelimit-requests-remaining": "42",
  });
  const out = sanitizeUpstreamResponseHeaders(upstream);

  assert.equal(out.get("content-encoding"), null, "content-encoding must be dropped");
  assert.equal(out.get("content-length"), null, "content-length must be dropped");
  assert.equal(out.get("content-type"), "application/json", "content-type must pass through");
  assert.equal(out.get("x-request-id"), "req_abc", "x-request-id must pass through");
  assert.equal(out.get("anthropic-ratelimit-requests-remaining"), "42");
});

test("sanitizeUpstreamResponseHeaders: strips all RFC 7230 hop-by-hop headers", () => {
  const upstream = new Headers({
    connection: "close",
    "keep-alive": "timeout=5",
    "transfer-encoding": "chunked",
    te: "trailers",
    trailer: "X-Trailer",
    upgrade: "h2c",
    "proxy-authenticate": "Basic",
    "proxy-authorization": "Bearer xxx",
    "proxy-connection": "close",
    "content-type": "text/event-stream",
  });
  const out = sanitizeUpstreamResponseHeaders(upstream);

  for (const name of [
    "connection",
    "keep-alive",
    "transfer-encoding",
    "te",
    "trailer",
    "upgrade",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
  ]) {
    assert.equal(out.get(name), null, `${name} must be dropped`);
  }
  // Non-hop-by-hop survives:
  assert.equal(out.get("content-type"), "text/event-stream");
});

test("sanitizeUpstreamResponseHeaders: returns a NEW Headers, does not mutate input", () => {
  const upstream = new Headers({
    "content-encoding": "gzip",
    "x-keep": "value",
  });
  const out = sanitizeUpstreamResponseHeaders(upstream);

  // Original still has content-encoding (not mutated):
  assert.equal(upstream.get("content-encoding"), "gzip");
  // Output is a different object:
  assert.notEqual(out, upstream);
  // Output had content-encoding stripped:
  assert.equal(out.get("content-encoding"), null);
  assert.equal(out.get("x-keep"), "value");
});

test("sanitizeUpstreamResponseHeaders: handles empty Headers", () => {
  const out = sanitizeUpstreamResponseHeaders(new Headers());
  let count = 0;
  out.forEach(() => count++);
  assert.equal(count, 0);
});

test("sanitizeUpstreamResponseHeaders: case-insensitive on input header names", () => {
  // Headers normalizes names to lowercase internally, but verify regardless.
  const upstream = new Headers();
  upstream.append("Content-Encoding", "br");
  upstream.append("X-Allowed", "ok");
  const out = sanitizeUpstreamResponseHeaders(upstream);
  assert.equal(out.get("content-encoding"), null);
  assert.equal(out.get("Content-Encoding"), null); // .get is case-insensitive
  assert.equal(out.get("x-allowed"), "ok");
});
