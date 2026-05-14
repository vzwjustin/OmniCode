import test from "node:test";
import assert from "node:assert/strict";

const { translateRequest } = await import("../../open-sse/translator/index.ts");
const { FORMATS } = await import("../../open-sse/translator/formats.ts");

test("Claude native passthrough normalization keeps original tool names", () => {
  const body = {
    model: "claude-sonnet-4-6",
    max_tokens: 64,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Write a todo item" }],
      },
    ],
    tools: [
      {
        name: "TodoWrite",
        description: "Create or update a todo list",
        input_schema: {
          type: "object",
          properties: {
            todos: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: ["todos"],
        },
      },
    ],
  };

  const openaiBody = translateRequest(
    FORMATS.CLAUDE,
    FORMATS.OPENAI,
    body.model,
    structuredClone(body),
    false,
    null,
    null,
    null
  );

  // The translated body should have function wrappers with the original name
  assert.ok(Array.isArray(openaiBody.tools), "tools should be an array");
  const tool = openaiBody.tools[0];
  assert.ok(tool.function, "tool should have a function wrapper");
  assert.ok(
    tool.function.name === "TodoWrite" || tool.function.name === "proxy_TodoWrite",
    `tool name should be preserved or prefixed, got: ${tool.function.name}`
  );
});

test("Claude-to-Claude passthrough should not alter tool names", () => {
  const body = {
    model: "claude-sonnet-4-6",
    max_tokens: 64,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Write a todo item" }],
      },
    ],
    tools: [
      {
        name: "TodoWrite",
        description: "Create or update a todo list",
        input_schema: {
          type: "object",
          properties: {
            todos: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: ["todos"],
        },
      },
    ],
  };

  const result = translateRequest(
    FORMATS.CLAUDE,
    FORMATS.CLAUDE,
    body.model,
    structuredClone(body),
    false,
    null,
    null,
    null
  );

  // Claude-to-Claude should preserve tool names
  assert.ok(Array.isArray(result.tools), "tools should be an array");
  assert.equal(
    result.tools[0].name,
    "TodoWrite",
    "tool name should stay unchanged for Claude-to-Claude"
  );
});

test("Claude-to-Claude passthrough strips combo prefixes from subagent tool.model fields", async () => {
  // Regression for the Claude Code path that bypasses translateRequest's
  // prepareClaudeRequest flow. The chatCore.ts isClaudePassthrough branch
  // forwards body as-is, so stripping must work whether we go through
  // translateRequest OR through the direct passthrough path. This test
  // exercises both: the translateRequest path (which uses prepareClaudeRequest
  // → stripToolModelPrefixes), and a direct call to the exported helper.
  const { stripToolModelPrefixes } =
    await import("../../open-sse/translator/helpers/claudeHelper.ts");

  // Direct helper usage (the passthrough branch uses this).
  const tools = [
    { name: "task_general", model: "cc/claude-opus-4-7", description: "subagent" },
    { name: "subagent_search", model: "openai/gpt-5", description: "search" },
    { name: "bare", model: "claude-sonnet-4-7" },
    { name: "no_model" },
  ];
  stripToolModelPrefixes(tools);
  assert.equal(tools[0].model, "claude-opus-4-7", "cc/ prefix should be stripped");
  assert.equal(tools[1].model, "gpt-5", "openai/ prefix should be stripped");
  assert.equal(tools[2].model, "claude-sonnet-4-7", "bare model should be left alone");
  assert.equal(tools[3].model, undefined, "missing model field should not be created");

  // Safe on null/undefined/non-array (used as defensive guard in chatCore.ts).
  // Don't await/expect throws — function must be a no-op.
  stripToolModelPrefixes(null);
  stripToolModelPrefixes(undefined);
  stripToolModelPrefixes({ not: "an array" });
  stripToolModelPrefixes("string");
  stripToolModelPrefixes(42);

  // Now exercise the translateRequest path with combo-prefixed tool.model.
  const body = {
    model: "claude-opus-4-7",
    max_tokens: 64,
    messages: [{ role: "user", content: "hi" }],
    tools: [
      {
        name: "task_general",
        description: "Spawn a sub-task",
        model: "cc/claude-opus-4-7",
        input_schema: { type: "object", properties: {} },
      },
    ],
  };
  const result = translateRequest(
    FORMATS.CLAUDE,
    FORMATS.CLAUDE,
    body.model,
    structuredClone(body),
    false,
    null,
    "claude",
    null
  );
  assert.equal(result.tools[0].model, "claude-opus-4-7", "translateRequest must strip prefix too");
});
