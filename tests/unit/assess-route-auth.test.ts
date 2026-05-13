/**
 * Assess route auth coverage (#auth-hardening).
 *
 * Asserts that POST/GET on `/api/assess/route.ts` return 401 without
 * authentication, and pass the guard with a valid session cookie or
 * manage-scoped API key.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SignJWT } from "jose";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-assess-auth-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.JWT_SECRET = "assess-route-auth-test-secret";
process.env.API_KEY_SECRET = "assess-route-api-key-secret";

const ORIGINAL_INITIAL_PASSWORD = process.env.INITIAL_PASSWORD;

const core = await import("../../src/lib/db/core.ts");
const localDb = await import("../../src/lib/localDb.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const assessRoute = await import("../../src/app/api/assess/route.ts");

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

test("GET /api/assess rejects unauthenticated requests with 401", async () => {
  await setupAuthRequired();
  const res = await assessRoute.GET(new Request("https://example.com/api/assess") as any);
  assert.equal(res.status, 401);
});

test("POST /api/assess rejects unauthenticated requests with 401", async () => {
  await setupAuthRequired();
  const res = await assessRoute.POST(
    new Request("https://example.com/api/assess", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    }) as any
  );
  assert.equal(res.status, 401);
});

test("GET /api/assess accepts a valid session cookie", async () => {
  await setupAuthRequired();
  const token = await makeSessionCookieToken();
  const req = new Request("https://example.com/api/assess", {
    headers: {
      cookie: `auth_token=${token}`,
      origin: "https://example.com",
    },
  });
  const res = await assessRoute.GET(req as any);
  assert.notEqual(res.status, 401);
});

test("GET /api/assess accepts a manage-scoped API key", async () => {
  await setupAuthRequired();
  const key = await apiKeysDb.createApiKey("manage-key", "machine-test", ["manage"]);
  const req = new Request("https://example.com/api/assess", {
    headers: { authorization: `Bearer ${key.key}` },
  });
  const res = await assessRoute.GET(req as any);
  assert.notEqual(res.status, 401);
});

test("GET /api/assess rejects an API key without manage scope (403)", async () => {
  await setupAuthRequired();
  const key = await apiKeysDb.createApiKey("plain-key", "machine-test");
  const req = new Request("https://example.com/api/assess", {
    headers: { authorization: `Bearer ${key.key}` },
  });
  const res = await assessRoute.GET(req as any);
  assert.equal(res.status, 403);
});
