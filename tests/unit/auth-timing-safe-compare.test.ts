/**
 * Tranche A — Task D3: regression tests for constant-time API-key compare.
 *
 * Covers:
 *   - `isValidApiKey` accepts the configured `OMNIROUTE_API_KEY` env value.
 *   - `isValidApiKey` rejects a mismatched key.
 *   - `isValidApiKey` rejects the empty string.
 *   - Structural check that BOTH call sites
 *     (`src/sse/services/auth.ts` and `src/lib/db/apiKeys.ts`)
 *     route the env-key compare through `crypto.timingSafeEqual` via the
 *     shared `secureCompareStrings` helper. This is verified by inspecting
 *     the source files because tsx/esm does not support `mock.module()`,
 *     so spying on the underlying `timingSafeEqual` call inside the
 *     destructured-imported module is not reliable here. (See
 *     tests/unit/proxyfetch-undici-retry.test.ts for the same limitation.)
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isValidApiKey } from "../../src/sse/services/auth.ts";
import { secureCompareStrings } from "../../src/lib/util/secureCompare.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ORIGINAL_OMNIROUTE_API_KEY = process.env.OMNIROUTE_API_KEY;
const ORIGINAL_ROUTER_API_KEY = process.env.ROUTER_API_KEY;

test.before(() => {
  process.env.OMNIROUTE_API_KEY = "correct-key";
  // ROUTER_API_KEY is the legacy alias — make sure it does not shadow the
  // primary so the test is unambiguous.
  delete process.env.ROUTER_API_KEY;
});

test.after(() => {
  if (ORIGINAL_OMNIROUTE_API_KEY === undefined) {
    delete process.env.OMNIROUTE_API_KEY;
  } else {
    process.env.OMNIROUTE_API_KEY = ORIGINAL_OMNIROUTE_API_KEY;
  }
  if (ORIGINAL_ROUTER_API_KEY === undefined) {
    delete process.env.ROUTER_API_KEY;
  } else {
    process.env.ROUTER_API_KEY = ORIGINAL_ROUTER_API_KEY;
  }
});

test("isValidApiKey accepts the configured env API key", async () => {
  assert.equal(await isValidApiKey("correct-key"), true);
});

test("isValidApiKey rejects a mismatched key", async () => {
  // Mismatched key never reaches the DB validator because the env path is
  // exercised first — but isValidApiKey returns `await validateApiKey(...)`
  // for any non-env key. Without a DB seeded, validateApiKey returns false.
  assert.equal(await isValidApiKey("wrong-key"), false);
});

test("isValidApiKey rejects the empty string", async () => {
  assert.equal(await isValidApiKey(""), false);
});

test("secureCompareStrings returns true for identical strings and false otherwise", () => {
  assert.equal(secureCompareStrings("correct-key", "correct-key"), true);
  assert.equal(secureCompareStrings("correct-key", "wrong-key"), false);
  assert.equal(secureCompareStrings("correct-key", ""), false);
  assert.equal(secureCompareStrings("", ""), true);
  assert.equal(secureCompareStrings(null, null), true);
  assert.equal(secureCompareStrings(null, "x"), false);
});

test("env-key compare paths route through crypto.timingSafeEqual (structural)", () => {
  // node:test mock.module() is unavailable on this Node/tsx/esm setup
  // (see tests/unit/proxyfetch-undici-retry.test.ts:1-7), so verify the
  // wiring structurally: the shared helper must be the only path used by
  // both call sites. If a future regression inlines a `===` compare, this
  // test will catch it before the network-observable timing oracle ships.
  const repoRoot = path.resolve(__dirname, "..", "..");

  const secureCompareSrc = fs.readFileSync(
    path.join(repoRoot, "src", "lib", "util", "secureCompare.ts"),
    "utf8"
  );
  assert.match(
    secureCompareSrc,
    /timingSafeEqual/,
    "secureCompare.ts must call crypto.timingSafeEqual"
  );

  const authSrc = fs.readFileSync(path.join(repoRoot, "src", "sse", "services", "auth.ts"), "utf8");
  assert.match(
    authSrc,
    /secureCompareStrings\s*\(\s*apiKey\s*,\s*envKey\s*\)/,
    "auth.ts isValidApiKey must compare via secureCompareStrings"
  );
  // And it MUST NOT contain a raw `apiKey === envKey` compare for the env path.
  assert.doesNotMatch(
    authSrc,
    /apiKey\s*===\s*envKey/,
    "auth.ts must not use a non-constant-time === compare for the env API key"
  );

  const apiKeysSrc = fs.readFileSync(path.join(repoRoot, "src", "lib", "db", "apiKeys.ts"), "utf8");
  assert.match(
    apiKeysSrc,
    /secureCompareStrings\s*\(\s*key\s*,\s*envKey\s*\)/,
    "apiKeys.ts isConfiguredEnvApiKey must compare via secureCompareStrings"
  );
  assert.doesNotMatch(
    apiKeysSrc,
    /key\s*===\s*envKey/,
    "apiKeys.ts must not use a non-constant-time === compare for the env API key"
  );
});
