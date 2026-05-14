import test from "node:test";
import assert from "node:assert/strict";

import { stripToolModelPrefixes } from "../../src/sse/handlers/chat";

test("stripToolModelPrefixes strips combo prefix from tools[i].model (Claude Code Task sub-agent)", () => {
  const body: any = {
    model: "cc/claude-opus-4-7",
    tools: [
      { name: "Bash", description: "shell", input_schema: { type: "object", properties: {} } },
      {
        name: "Task",
        description: "subagent",
        model: "cc/claude-opus-4-7",
        input_schema: { type: "object", properties: {} },
      },
    ],
  };

  stripToolModelPrefixes(body);

  assert.equal(body.tools[1].model, "claude-opus-4-7", "combo prefix must be stripped");
  // Other tool fields untouched
  assert.equal(body.tools[0].name, "Bash");
  assert.equal(body.tools[1].name, "Task");
  // Top-level body.model is *not* touched by this function (combo dispatcher owns that).
  assert.equal(body.model, "cc/claude-opus-4-7");
});

test("stripToolModelPrefixes strips arbitrary alias prefixes (cm/, if/, custom/)", () => {
  const body: any = {
    tools: [
      { name: "T1", model: "cm/claude-sonnet-4-5-20250929" },
      { name: "T2", model: "if/kimi-k2-thinking" },
      { name: "T3", model: "custom-combo/claude-haiku-4-5-20251001" },
    ],
  };

  stripToolModelPrefixes(body);

  assert.equal(body.tools[0].model, "claude-sonnet-4-5-20250929");
  assert.equal(body.tools[1].model, "kimi-k2-thinking");
  assert.equal(body.tools[2].model, "claude-haiku-4-5-20251001");
});

test("stripToolModelPrefixes leaves bare model ids unchanged", () => {
  const body: any = {
    tools: [
      { name: "Task", model: "claude-opus-4-7" },
      { name: "Other", model: "claude-sonnet-4-5-20250929" },
    ],
  };

  stripToolModelPrefixes(body);

  assert.equal(body.tools[0].model, "claude-opus-4-7");
  assert.equal(body.tools[1].model, "claude-sonnet-4-5-20250929");
});

test("stripToolModelPrefixes is a no-op when tools have no model field", () => {
  const body: any = {
    tools: [
      { name: "Bash", description: "shell", input_schema: { type: "object", properties: {} } },
      { name: "Read", description: "read", input_schema: { type: "object", properties: {} } },
    ],
  };

  const before = JSON.stringify(body);
  stripToolModelPrefixes(body);
  assert.equal(JSON.stringify(body), before, "body must be unchanged");
});

test("stripToolModelPrefixes is safe with missing/invalid tools array", () => {
  // No throws for any of these shapes:
  assert.doesNotThrow(() => stripToolModelPrefixes(null));
  assert.doesNotThrow(() => stripToolModelPrefixes(undefined));
  assert.doesNotThrow(() => stripToolModelPrefixes({}));
  assert.doesNotThrow(() => stripToolModelPrefixes({ tools: null }));
  assert.doesNotThrow(() => stripToolModelPrefixes({ tools: "not-an-array" }));
  assert.doesNotThrow(() => stripToolModelPrefixes({ tools: [null, undefined, "string", 42] }));
});

test("stripToolModelPrefixes is idempotent", () => {
  const body: any = {
    tools: [
      { name: "Task", model: "cc/claude-opus-4-7" },
      { name: "T2", model: "claude-sonnet-4-5-20250929" },
    ],
  };

  stripToolModelPrefixes(body);
  const afterFirst = JSON.parse(JSON.stringify(body));

  stripToolModelPrefixes(body);
  assert.deepEqual(body, afterFirst, "second call must produce same result");
  assert.equal(body.tools[0].model, "claude-opus-4-7");
});

test("stripToolModelPrefixes ignores trailing-slash edge cases", () => {
  const body: any = {
    tools: [
      { name: "T1", model: "cc/" }, // no model after slash — leave as-is to avoid producing empty string
      { name: "T2", model: "/claude-opus-4-7" }, // leading slash — leave as-is, not a recognizable prefix
      { name: "T3", model: "" }, // empty — leave as-is
    ],
  };

  stripToolModelPrefixes(body);

  assert.equal(body.tools[0].model, "cc/");
  assert.equal(body.tools[1].model, "/claude-opus-4-7");
  assert.equal(body.tools[2].model, "");
});
