/**
 * Tests for sanitizeUpstreamHeaders / stripUpstreamHeaderHazards
 *
 * Regression for ZlibError on client side when Node's fetch auto-decompresses
 * an upstream response body but the Content-Encoding header is forwarded
 * unchanged, causing the client to attempt gunzip on already-plain bytes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  sanitizeUpstreamHeaders,
  stripUpstreamHeaderHazards,
  __STRIPPED_UPSTREAM_HEADERS_FOR_TESTING,
} from "../../open-sse/utils/responseHeaders.ts";

test("sanitizeUpstreamHeaders strips Content-Encoding (gzip, br, deflate, zstd)", () => {
  for (const encoding of ["gzip", "br", "deflate", "zstd", "gzip, br"]) {
    const upstream = new Headers({
      "Content-Type": "text/event-stream",
      "Content-Encoding": encoding,
      "X-Custom": "preserved",
    });
    const sanitized = sanitizeUpstreamHeaders(upstream);
    assert.equal(
      sanitized.get("Content-Encoding"),
      null,
      `Content-Encoding: ${encoding} should be stripped`
    );
    assert.equal(sanitized.get("Content-Type"), "text/event-stream");
    assert.equal(sanitized.get("X-Custom"), "preserved");
  }
});

test("sanitizeUpstreamHeaders strips Content-Length (becomes wrong after transform)", () => {
  const upstream = new Headers({
    "Content-Length": "12345",
    "X-Other": "kept",
  });
  const sanitized = sanitizeUpstreamHeaders(upstream);
  assert.equal(sanitized.get("Content-Length"), null);
  assert.equal(sanitized.get("X-Other"), "kept");
});

test("sanitizeUpstreamHeaders strips RFC 7230 hop-by-hop headers", () => {
  const upstream = new Headers({
    Connection: "keep-alive",
    "Keep-Alive": "timeout=5",
    "Proxy-Authenticate": "Basic",
    "Proxy-Authorization": "Basic xxx",
    TE: "trailers",
    Trailers: "X-Foo",
    "Transfer-Encoding": "chunked",
    Upgrade: "websocket",
    "X-App-Header": "kept",
  });
  const sanitized = sanitizeUpstreamHeaders(upstream);
  assert.equal(sanitized.get("Connection"), null);
  assert.equal(sanitized.get("Keep-Alive"), null);
  assert.equal(sanitized.get("Proxy-Authenticate"), null);
  assert.equal(sanitized.get("Proxy-Authorization"), null);
  assert.equal(sanitized.get("TE"), null);
  assert.equal(sanitized.get("Trailers"), null);
  assert.equal(sanitized.get("Transfer-Encoding"), null);
  assert.equal(sanitized.get("Upgrade"), null);
  assert.equal(sanitized.get("X-App-Header"), "kept");
});

test("sanitizeUpstreamHeaders is case-insensitive", () => {
  for (const variant of ["CONTENT-ENCODING", "Content-Encoding", "content-encoding"]) {
    const upstream = new Headers();
    upstream.set(variant, "gzip");
    const sanitized = sanitizeUpstreamHeaders(upstream);
    assert.equal(sanitized.get("content-encoding"), null, `${variant} should be stripped`);
  }
});

test("sanitizeUpstreamHeaders returns empty Headers for null/undefined input", () => {
  assert.equal([...sanitizeUpstreamHeaders(null).entries()].length, 0);
  assert.equal([...sanitizeUpstreamHeaders(undefined).entries()].length, 0);
});

test("sanitizeUpstreamHeaders accepts HeadersInit (plain object)", () => {
  const sanitized = sanitizeUpstreamHeaders({
    "Content-Type": "application/json",
    "Content-Encoding": "gzip",
  });
  assert.equal(sanitized.get("Content-Type"), "application/json");
  assert.equal(sanitized.get("Content-Encoding"), null);
});

test("sanitizeUpstreamHeaders returns a NEW Headers (does not mutate input)", () => {
  const upstream = new Headers({
    "Content-Encoding": "gzip",
    "X-Keep": "yes",
  });
  const sanitized = sanitizeUpstreamHeaders(upstream);
  // Input unchanged
  assert.equal(upstream.get("Content-Encoding"), "gzip");
  // Output stripped
  assert.equal(sanitized.get("Content-Encoding"), null);
  assert.equal(sanitized.get("X-Keep"), "yes");
});

test("stripUpstreamHeaderHazards mutates in place", () => {
  const headers = new Headers({
    "Content-Encoding": "br",
    "Content-Length": "100",
    Connection: "close",
    "X-Custom": "kept",
  });
  stripUpstreamHeaderHazards(headers);
  assert.equal(headers.get("Content-Encoding"), null);
  assert.equal(headers.get("Content-Length"), null);
  assert.equal(headers.get("Connection"), null);
  assert.equal(headers.get("X-Custom"), "kept");
});

test("STRIPPED_UPSTREAM_HEADERS covers the documented set", () => {
  const expected = [
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
  ];
  for (const name of expected) {
    assert.ok(__STRIPPED_UPSTREAM_HEADERS_FOR_TESTING.has(name), `${name} must be in strip set`);
  }
});

test("sanitizeUpstreamHeaders preserves non-hazardous duplicates (e.g. Set-Cookie)", () => {
  const upstream = new Headers();
  upstream.append("Set-Cookie", "a=1; Path=/");
  upstream.append("Set-Cookie", "b=2; Path=/");
  const sanitized = sanitizeUpstreamHeaders(upstream);
  const cookies = sanitized.getSetCookie?.() || [sanitized.get("Set-Cookie")];
  assert.ok(cookies.length >= 1, "Set-Cookie should be preserved");
});
