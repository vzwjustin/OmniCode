/**
 * Unit tests for `selectBetaFlags()` — gates the `context-1m-2025-08-07`
 * beta header on per-model support so Anthropic does not reject the request
 * with the misleading "long context beta is not yet available for this
 * subscription" error when hitting a non-Sonnet model (Opus has 200k native
 * context but does not accept the 1M beta even on entitled subscriptions).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { selectBetaFlags } from "../../open-sse/executors/claudeIdentity.ts";

const FULL_AGENT_BASE = {
  system: "You are Claude.",
  tools: [{ name: "Bash", description: "shell", input_schema: { type: "object" } }],
};

test("selectBetaFlags: omits context-1m on Opus full-agent request", () => {
  const flags = selectBetaFlags({ ...FULL_AGENT_BASE, model: "claude-opus-4-7" }).split(",");
  assert.ok(!flags.includes("context-1m-2025-08-07"), "should NOT send 1M beta on Opus");
  assert.ok(flags.includes("claude-code-20250219"), "should still send claude-code beta");
  assert.ok(flags.includes("oauth-2025-04-20"), "should still send oauth beta");
});

test("selectBetaFlags: omits context-1m on every Opus 4.x variant", () => {
  for (const model of [
    "claude-opus-4",
    "claude-opus-4-1",
    "claude-opus-4-5",
    "claude-opus-4-6",
    "claude-opus-4-7",
    "claude-opus-4-7-20251101",
  ]) {
    const flags = selectBetaFlags({ ...FULL_AGENT_BASE, model }).split(",");
    assert.ok(!flags.includes("context-1m-2025-08-07"), `should NOT send 1M beta on ${model}`);
  }
});

test("selectBetaFlags: sends context-1m on Sonnet 4.x full-agent request", () => {
  for (const model of [
    "claude-sonnet-4",
    "claude-sonnet-4-5",
    "claude-sonnet-4-6",
    "claude-sonnet-4-7",
    "claude-sonnet-4-5-20250929",
  ]) {
    const flags = selectBetaFlags({ ...FULL_AGENT_BASE, model }).split(",");
    assert.ok(flags.includes("context-1m-2025-08-07"), `should send 1M beta on ${model}`);
  }
});

test("selectBetaFlags: omits context-1m when not a full-agent (no tools)", () => {
  // Even on Sonnet, only "full agent" shape (tools + system) gets the 1M beta —
  // matches real claude-cli probe behavior.
  const flags = selectBetaFlags({
    system: "You are Claude.",
    model: "claude-sonnet-4-5",
  }).split(",");
  assert.ok(!flags.includes("context-1m-2025-08-07"), "no tools → no 1M beta");
});

test("selectBetaFlags: omits context-1m when not a full-agent (no system)", () => {
  const flags = selectBetaFlags({
    tools: [{ name: "Bash", description: "shell", input_schema: { type: "object" } }],
    model: "claude-sonnet-4-5",
  }).split(",");
  assert.ok(!flags.includes("context-1m-2025-08-07"), "no system → no 1M beta");
});

test("selectBetaFlags: omits context-1m when model field is missing", () => {
  const flags = selectBetaFlags(FULL_AGENT_BASE).split(",");
  assert.ok(!flags.includes("context-1m-2025-08-07"), "missing model field → no 1M beta");
});

test("selectBetaFlags: omits context-1m on unknown / typo'd Sonnet name", () => {
  for (const model of ["claude-sonnet-3-5", "claude-haiku-4-5", "sonnet", "claude-sonnet"]) {
    const flags = selectBetaFlags({ ...FULL_AGENT_BASE, model }).split(",");
    assert.ok(!flags.includes("context-1m-2025-08-07"), `should NOT send 1M beta on ${model}`);
  }
});

test("selectBetaFlags: handles null/undefined body without throwing", () => {
  assert.doesNotThrow(() => selectBetaFlags(null));
  assert.doesNotThrow(() => selectBetaFlags(undefined));
  const flags = selectBetaFlags(null).split(",");
  // null body → no tools, no system → minimal probe shape, no 1M beta
  assert.ok(!flags.includes("context-1m-2025-08-07"));
  // oauth flag still present (every CLI request gets it)
  assert.ok(flags.includes("oauth-2025-04-20"));
});
