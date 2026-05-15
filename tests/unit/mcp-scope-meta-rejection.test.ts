/**
 * Tranche A — Task D2: regression tests proving that client-controlled
 * `_meta.scopes` is rejected by the MCP scope resolver.
 *
 * Covers:
 *   1. `resolveCallerScopeContext` returns `{ scopes: [], source: "none" }`
 *      when authInfo has no scopes and the client supplied `_meta.scopes: ["*"]`.
 *   2. `evaluateToolScopes` denies a tool that requires a real scope when the
 *      caller's resolved scopes are empty (the "after-rejection" view).
 *   3. When authInfo DOES carry server-attested scopes, those still win and
 *      `_meta.scopes` is ignored — the source is reported as "authInfo".
 *
 * Pairs with the existing tests/unit/t08-mcp-scope-enforcement.test.ts.
 * These three cases are the minimum acceptance set for Tranche A — Task A4.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateToolScopes,
  resolveCallerScopeContext,
} from "../../open-sse/mcp-server/scopeEnforcement.ts";

test("resolveCallerScopeContext rejects client-supplied _meta.scopes wildcard", () => {
  // SECURITY (Task A4): every transport (stdio, SSE, streamable-http) exposes
  // `_meta` as a CLIENT-CONTROLLED payload. Setting `_meta.scopes: ["*"]`
  // MUST NOT grant scopes when authInfo is empty.
  const context = resolveCallerScopeContext(
    {
      authInfo: { scopes: [] },
      _meta: { scopes: ["*"] },
    },
    []
  );

  assert.equal(context.source, "none");
  assert.deepEqual(context.scopes, []);
});

test("evaluateToolScopes denies omniroute_get_health when no scopes are resolved", () => {
  // omniroute_get_health requires the `read:health` scope
  // (open-sse/mcp-server/schemas/tools.ts:90).
  const result = evaluateToolScopes("omniroute_get_health", [], true);

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "missing_scopes");
  assert.ok(
    result.missing.includes("read:health"),
    "expected the missing-scope list to surface read:health"
  );
});

test("resolveCallerScopeContext still honors authInfo.scopes when _meta is hostile", () => {
  // authInfo (set by the transport's auth layer, NOT the client payload) is
  // the only trusted source. _meta.scopes is ignored — but lawful authInfo
  // scopes must still be returned with source: "authInfo".
  const context = resolveCallerScopeContext(
    {
      authInfo: { scopes: ["read:health"] },
      _meta: { scopes: ["*"] },
    },
    []
  );

  assert.equal(context.source, "authInfo");
  assert.deepEqual(context.scopes, ["read:health"]);
});
