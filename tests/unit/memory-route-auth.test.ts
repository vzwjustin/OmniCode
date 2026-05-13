/**
 * Memory route auth coverage (#auth-hardening).
 *
 * Asserts that every exported handler on `/api/memory/...` route files is
 * guarded by `requireManagementAuth`. The routes call the auth helper as the
 * very first step, so we can exercise the unauthenticated branch by simply
 * invoking the route handler without credentials and asserting a 401.
 *
 * Authenticated requests are validated by stubbing the JWT cookie path the
 * helper checks; we do NOT exercise the deep handler logic (separate DB tests
 * cover those) — just confirm that auth gating produces the expected
 * pass-through (non-401) result.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SignJWT } from "jose";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-memory-auth-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.JWT_SECRET = "memory-route-auth-test-secret";
process.env.API_KEY_SECRET = "memory-route-api-key-secret";

const ORIGINAL_INITIAL_PASSWORD = process.env.INITIAL_PASSWORD;

const core = await import("../../src/lib/db/core.ts");
const localDb = await import("../../src/lib/localDb.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");

const memoryRoot = await import("../../src/app/api/memory/route.ts");
const memoryById = await import("../../src/app/api/memory/[id]/route.ts");
const memoryHealth = await import("../../src/app/api/memory/health/route.ts");

async function setupAuthRequired() {
  process.env.INITIAL_PASSWORD = "bootstrap-password";
  await localDb.updateSettings({ requireLogin: true, password: "" });
}

async function reset() {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  delete process.env.INITIAL_PASSWORD;
}

async function makeSessionCookieToken(): Promise<string> {
  const secret = new TextEncoder().encode(process.env.JWT_SECRET);
  return new SignJWT({ authenticated: true })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(secret);
}

function unauthRequest(url: string, method = "GET"): Request {
  return new Request(url, { method });
}

async function sessionAuthRequest(url: string, method = "GET"): Promise<Request> {
  const token = await makeSessionCookieToken();
  return new Request(url, {
    method,
    headers: {
      cookie: `auth_token=${token}`,
      // Same-origin Origin header so the CSRF check (POST/DELETE) passes.
      origin: new URL(url).origin,
    },
  });
}

test.beforeEach(async () => {
  await reset();
});

test.after(() => {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  if (ORIGINAL_INITIAL_PASSWORD === undefined) {
    delete process.env.INITIAL_PASSWORD;
  } else {
    process.env.INITIAL_PASSWORD = ORIGINAL_INITIAL_PASSWORD;
  }
});

test("GET /api/memory rejects unauthenticated requests with 401", async () => {
  await setupAuthRequired();
  const res = await memoryRoot.GET(unauthRequest("https://example.com/api/memory"));
  assert.equal(res.status, 401);
});

test("POST /api/memory rejects unauthenticated requests with 401", async () => {
  await setupAuthRequired();
  const res = await memoryRoot.POST(
    new Request("https://example.com/api/memory", {
      method: "POST",
      body: JSON.stringify({ content: "x", key: "k" }),
      headers: { "content-type": "application/json" },
    })
  );
  assert.equal(res.status, 401);
});

test("DELETE /api/memory/[id] rejects unauthenticated requests with 401", async () => {
  await setupAuthRequired();
  const res = await memoryById.DELETE(
    unauthRequest("https://example.com/api/memory/abc", "DELETE"),
    { params: Promise.resolve({ id: "abc" }) }
  );
  assert.equal(res.status, 401);
});

test("GET /api/memory/[id] rejects unauthenticated requests with 401", async () => {
  await setupAuthRequired();
  const res = await memoryById.GET(unauthRequest("https://example.com/api/memory/abc"), {
    params: Promise.resolve({ id: "abc" }),
  });
  assert.equal(res.status, 401);
});

test("GET /api/memory/health rejects unauthenticated requests with 401", async () => {
  await setupAuthRequired();
  const res = await memoryHealth.GET(unauthRequest("https://example.com/api/memory/health"));
  assert.equal(res.status, 401);
});

test("GET /api/memory accepts a valid session cookie (auth check passes)", async () => {
  await setupAuthRequired();
  const req = await sessionAuthRequest("https://example.com/api/memory");
  const res = await memoryRoot.GET(req);
  // Auth passed — anything that is NOT 401 indicates the guard let us through.
  assert.notEqual(res.status, 401);
});

test("GET /api/memory accepts a valid manage-scoped API key", async () => {
  await setupAuthRequired();
  const key = await apiKeysDb.createApiKey("manage-key", "machine-test", ["manage"]);
  const req = new Request("https://example.com/api/memory", {
    headers: { authorization: `Bearer ${key.key}` },
  });
  const res = await memoryRoot.GET(req);
  assert.notEqual(res.status, 401);
});

test("DELETE /api/memory/[id] returns 204/404/non-401 with valid session cookie", async () => {
  await setupAuthRequired();
  const req = await sessionAuthRequest("https://example.com/api/memory/missing-id", "DELETE");
  const res = await memoryById.DELETE(req, {
    params: Promise.resolve({ id: "missing-id" }),
  });
  // Either 200/204 (delete succeeded) or 404 (not found) is acceptable —
  // the key invariant is we got past auth.
  assert.notEqual(res.status, 401);
  assert.ok([200, 204, 404, 500].includes(res.status), `unexpected status ${res.status}`);
});
