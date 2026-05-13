/**
 * Policies route auth coverage (#auth-hardening).
 *
 * Asserts that POST/GET on `/api/policies/route.ts` return 401 without a
 * session cookie or manage-scoped API key, and pass auth gating when valid
 * credentials are supplied.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SignJWT } from "jose";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-policies-auth-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.JWT_SECRET = "policies-route-auth-test-secret";
process.env.API_KEY_SECRET = "policies-route-api-key-secret";

const ORIGINAL_INITIAL_PASSWORD = process.env.INITIAL_PASSWORD;

const core = await import("../../src/lib/db/core.ts");
const localDb = await import("../../src/lib/localDb.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const policiesRoute = await import("../../src/app/api/policies/route.ts");

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

test("GET /api/policies rejects unauthenticated requests with 401", async () => {
  await setupAuthRequired();
  const res = await policiesRoute.GET(new Request("https://example.com/api/policies"));
  assert.equal(res.status, 401);
});

test("POST /api/policies rejects unauthenticated requests with 401", async () => {
  await setupAuthRequired();
  const res = await policiesRoute.POST(
    new Request("https://example.com/api/policies", {
      method: "POST",
      body: JSON.stringify({ action: "unlock", identifier: "x" }),
      headers: { "content-type": "application/json" },
    })
  );
  assert.equal(res.status, 401);
});

test("GET /api/policies accepts a valid session cookie", async () => {
  await setupAuthRequired();
  const token = await makeSessionCookieToken();
  const req = new Request("https://example.com/api/policies", {
    headers: {
      cookie: `auth_token=${token}`,
      origin: "https://example.com",
    },
  });
  const res = await policiesRoute.GET(req);
  assert.notEqual(res.status, 401);
});

test("POST /api/policies accepts a valid session cookie", async () => {
  await setupAuthRequired();
  const token = await makeSessionCookieToken();
  const req = new Request("https://example.com/api/policies", {
    method: "POST",
    body: JSON.stringify({ action: "unlock", identifier: "x" }),
    headers: {
      cookie: `auth_token=${token}`,
      "content-type": "application/json",
      origin: "https://example.com",
    },
  });
  const res = await policiesRoute.POST(req);
  assert.notEqual(res.status, 401);
});

test("GET /api/policies accepts a manage-scoped API key", async () => {
  await setupAuthRequired();
  const key = await apiKeysDb.createApiKey("manage-key", "machine-test", ["manage"]);
  const req = new Request("https://example.com/api/policies", {
    headers: { authorization: `Bearer ${key.key}` },
  });
  const res = await policiesRoute.GET(req);
  assert.notEqual(res.status, 401);
});

test("GET /api/policies rejects an API key without manage scope (403)", async () => {
  await setupAuthRequired();
  const key = await apiKeysDb.createApiKey("plain-key", "machine-test");
  const req = new Request("https://example.com/api/policies", {
    headers: { authorization: `Bearer ${key.key}` },
  });
  const res = await policiesRoute.GET(req);
  assert.equal(res.status, 403);
});
