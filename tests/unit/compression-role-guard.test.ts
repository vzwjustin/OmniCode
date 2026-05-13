import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ultraCompress } from "../../open-sse/services/compression/ultra.ts";
import { compressAggressive } from "../../open-sse/services/compression/aggressive.ts";

const LONG_TOOL_PAYLOAD = JSON.stringify({
  ok: true,
  items: Array.from({ length: 50 }, (_, i) => ({
    id: i,
    note: `An informational note about item ${i} that should not be compressed away because it lives inside a tool result payload. ${"x".repeat(40)}`,
  })),
});

describe("compression role guards", () => {
  describe("ultraCompress", () => {
    it("leaves role:'tool' messages unchanged even when long", () => {
      const messages = [
        { role: "user", content: "Please run the tool." },
        { role: "tool", tool_call_id: "call_1", content: LONG_TOOL_PAYLOAD },
      ];
      const result = ultraCompress(messages, { maxTokensPerMessage: 1 });
      const toolMsg = result.messages.find((m) => m.role === "tool");
      assert.ok(toolMsg);
      assert.equal(toolMsg!.content, LONG_TOOL_PAYLOAD);
    });

    it("leaves role:'function' messages unchanged even when long", () => {
      const messages = [
        { role: "user", content: "call function" },
        { role: "function", name: "lookup", content: LONG_TOOL_PAYLOAD },
      ];
      const result = ultraCompress(messages, { maxTokensPerMessage: 1 });
      const fnMsg = result.messages.find((m) => m.role === "function");
      assert.ok(fnMsg);
      assert.equal(fnMsg!.content, LONG_TOOL_PAYLOAD);
    });

    it("leaves messages containing tool_use / tool_result blocks unchanged", () => {
      const structured = [
        { type: "text", text: "I'll call the tool.".repeat(40) },
        {
          type: "tool_use",
          id: "tool_1",
          name: "get_weather",
          input: { location: "San Francisco" },
        },
      ];
      const messages = [
        { role: "user", content: "weather?" },
        { role: "assistant", content: structured },
      ];
      const result = ultraCompress(messages, { maxTokensPerMessage: 1 });
      const assistantMsg = result.messages.find((m) => m.role === "assistant");
      assert.ok(assistantMsg);
      assert.deepEqual(assistantMsg!.content, structured);
    });
  });

  describe("compressAggressive", () => {
    it("leaves role:'tool' messages unchanged even when long", () => {
      const messages = [
        { role: "user", content: "Please run the tool." },
        { role: "tool", tool_call_id: "call_1", content: LONG_TOOL_PAYLOAD },
      ];
      const result = compressAggressive(messages, {
        summarizerEnabled: true,
        maxTokensPerMessage: 1,
        // Set threshold to 0 so downgrade chain doesn't run lite fallback
        minSavingsThreshold: 0,
        // Disable tool-strategy compression so we exercise the role guard on summarizer step
        toolStrategies: {
          fileContent: false,
          grepSearch: false,
          shellOutput: false,
          json: false,
          errorMessage: false,
        },
      });
      const toolMsg = result.messages.find((m) => m.role === "tool");
      assert.ok(toolMsg);
      assert.equal(toolMsg!.content, LONG_TOOL_PAYLOAD);
    });

    it("leaves role:'function' messages unchanged even when long", () => {
      const messages = [
        { role: "user", content: "call function" },
        { role: "function", name: "lookup", content: LONG_TOOL_PAYLOAD },
      ];
      const result = compressAggressive(messages, {
        summarizerEnabled: true,
        maxTokensPerMessage: 1,
        // Set threshold to 0 so downgrade chain doesn't run lite fallback
        minSavingsThreshold: 0,
        toolStrategies: {
          fileContent: false,
          grepSearch: false,
          shellOutput: false,
          json: false,
          errorMessage: false,
        },
      });
      const fnMsg = result.messages.find((m) => m.role === "function");
      assert.ok(fnMsg);
      assert.equal(fnMsg!.content, LONG_TOOL_PAYLOAD);
    });

    it("leaves messages containing tool_use blocks unchanged in summarizer step", () => {
      const structured = [
        { type: "text", text: "I'll call the tool. ".repeat(80) },
        {
          type: "tool_use",
          id: "tool_1",
          name: "get_weather",
          input: { location: "Seattle" },
        },
      ];
      const messages = [
        { role: "user", content: "weather?" },
        { role: "assistant", content: structured },
      ];
      const result = compressAggressive(messages, {
        summarizerEnabled: true,
        maxTokensPerMessage: 1,
        // Set threshold to 0 so downgrade chain doesn't run lite fallback
        minSavingsThreshold: 0,
        toolStrategies: {
          fileContent: false,
          grepSearch: false,
          shellOutput: false,
          json: false,
          errorMessage: false,
        },
      });
      const assistantMsg = result.messages.find((m) => m.role === "assistant");
      assert.ok(assistantMsg);
      assert.deepEqual(assistantMsg!.content, structured);
    });
  });
});
