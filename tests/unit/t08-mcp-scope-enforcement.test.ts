import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateToolScopes,
  resolveCallerScopeContext,
} from "../../open-sse/mcp-server/scopeEnforcement.ts";

test("resolveCallerScopeContext prioritizes authInfo scopes", () => {
  const context = resolveCallerScopeContext(
    {
      authInfo: {
        clientId: "client-auth",
        scopes: ["read:health", "read:combos"],
      },
      _meta: { scopes: ["write:combos"] },
      sessionId: "session-1",
    },
    ["read:usage"]
  );

  assert.equal(context.callerId, "client-auth");
  assert.equal(context.source, "authInfo");
  assert.deepEqual(context.scopes, ["read:health", "read:combos"]);
});

test("resolveCallerScopeContext rejects client-supplied _meta scopes (A4)", () => {
  // Tranche A — Task A4: _meta is client-controlled on stdio/SSE/streamable
  // transports. Setting `_meta.scopes` MUST NOT grant any privilege; the
  // resolver must fall through to env fallback (empty here) and surface
  // source: "none" with an empty scope list.
  const context = resolveCallerScopeContext(
    {
      _meta: {
        scopes: ["read:quota", "read:models"],
      },
      sessionId: "session-meta",
    },
    []
  );

  assert.equal(context.callerId, "session-meta");
  assert.equal(context.source, "none");
  assert.deepEqual(context.scopes, []);
});

test("resolveCallerScopeContext uses env fallback when caller has no scopes", () => {
  const context = resolveCallerScopeContext({ sessionId: "session-env" }, ["read:health"]);
  assert.equal(context.source, "env");
  assert.deepEqual(context.scopes, ["read:health"]);
});

test("evaluateToolScopes allows requests when enforcement is disabled", () => {
  const check = evaluateToolScopes("omniroute_switch_combo", [], false);
  assert.equal(check.allowed, true);
  assert.deepEqual(check.missing, []);
});

test("evaluateToolScopes denies tool execution when required scope is missing", () => {
  const check = evaluateToolScopes("omniroute_switch_combo", ["read:combos"], true);
  assert.equal(check.allowed, false);
  assert.ok(check.missing.includes("write:combos"));
  assert.equal(check.reason, "missing_scopes");
});

test("evaluateToolScopes supports wildcard scopes", () => {
  const check = evaluateToolScopes("omniroute_get_health", ["read:*"], true);
  assert.equal(check.allowed, true);
  assert.deepEqual(check.missing, []);
});

test("evaluateToolScopes denies unknown tool names", () => {
  const check = evaluateToolScopes("omniroute_unknown_tool", ["*"], true);
  assert.equal(check.allowed, false);
  assert.equal(check.reason, "tool_definition_missing");
});
