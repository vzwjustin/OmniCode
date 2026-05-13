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

test("resolveCallerScopeContext IGNORES caller-supplied _meta scopes (no privilege escalation)", () => {
  const context = resolveCallerScopeContext(
    {
      _meta: {
        scopes: ["read:quota", "read:models"],
      },
      sessionId: "session-meta",
    },
    ["read:usage"]
  );

  // Caller-supplied _meta scopes must NEVER be honored; we fall through to the env fallback.
  assert.equal(context.callerId, "session-meta");
  assert.equal(context.source, "env");
  assert.deepEqual(context.scopes, ["read:usage"]);
});

test("resolveCallerScopeContext IGNORES _meta scopes even when no env fallback is set", () => {
  const context = resolveCallerScopeContext(
    {
      _meta: {
        scopes: ["write:everything"],
      },
      sessionId: "session-escalation",
    },
    []
  );

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
