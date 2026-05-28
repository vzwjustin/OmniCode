import test from "node:test";
import assert from "node:assert/strict";

import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";

const harness = await createChatPipelineHarness("local-fusion-unit");
const { BaseExecutor, buildRequest, handleChat, resetStorage, seedConnection } = harness;

const {
  getFusionConfig: _readFusionConfig,
  setFusionConfig,
  resetFusionConfig,
} = await import("../../src/lib/db/fusionConfig.ts");
const { isFusionModelId, parseFusionModelName, clearFusionCache } =
  await import("../../open-sse/handlers/fusion.ts");

function resetEnv() {
  process.env.REQUIRE_API_KEY = "false";
  delete process.env.INPUT_SANITIZER_ENABLED;
  delete process.env.INPUT_SANITIZER_MODE;
  delete process.env.PII_REDACTION_ENABLED;
}

interface UpstreamCall {
  model: string;
  messages: Array<{ role: string; content: string }>;
}

function buildOpenAIResponse(content: string) {
  return new Response(
    JSON.stringify({
      id: "chatcmpl_test",
      object: "chat.completion",
      model: "test",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 4, completion_tokens: 8, total_tokens: 12 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function buildAnthropicResponse(content: string) {
  return new Response(
    JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: content }],
      model: "claude-test",
      stop_reason: "end_turn",
      usage: { input_tokens: 4, output_tokens: 8 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function buildGeminiResponse(content: string) {
  return new Response(
    JSON.stringify({
      candidates: [
        {
          content: { parts: [{ text: content }], role: "model" },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 8, totalTokenCount: 12 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function pickResponseFor(model: string, content: string): Response {
  if (model.includes("anthropic") || model.includes("claude")) {
    return buildAnthropicResponse(content);
  }
  if (model.includes("gemini") || model.includes("google")) {
    return buildGeminiResponse(content);
  }
  return buildOpenAIResponse(content);
}

interface MockFetchOptions {
  byModel?: Record<string, string | Error>;
  defaultReply?: string;
  capture?: UpstreamCall[];
}

function installFetchMock(opts: MockFetchOptions = {}): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any = {}) => {
    let parsed: any = null;
    try {
      parsed = JSON.parse(String(init.body || "{}"));
    } catch {
      parsed = null;
    }
    const model = String(parsed?.model || "");
    if (opts.capture) {
      opts.capture.push({
        model,
        messages: parsed?.messages || [],
      });
    }
    const lookup = opts.byModel?.[model];
    if (lookup instanceof Error) throw lookup;
    const replyContent =
      (lookup as string | undefined) ?? opts.defaultReply ?? `[default-mock for ${model}]`;
    return pickResponseFor(model, replyContent);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test.beforeEach(async () => {
  BaseExecutor.RETRY_CONFIG.delayMs = 0;
  resetEnv();
  await resetStorage();
  resetFusionConfig();
  clearFusionCache();
});

test.afterEach(async () => {
  resetEnv();
  await resetStorage();
  resetFusionConfig();
  clearFusionCache();
});

test.after(async () => {
  await harness.cleanup();
});

test("isFusionModelId recognizes the standard aliases and inline forms", () => {
  assert.equal(isFusionModelId("local-fusion"), true);
  assert.equal(isFusionModelId("local-fusion-fast"), true);
  assert.equal(isFusionModelId("local-fusion-code"), true);
  assert.equal(isFusionModelId("local-fusion-code:m1+m2@judge"), true);
  assert.equal(isFusionModelId("local-fusion@judge"), true);
  assert.equal(isFusionModelId("anthropic/claude-opus-4.7"), false);
  assert.equal(isFusionModelId("auto"), false);
  assert.equal(isFusionModelId(""), false);
  assert.equal(isFusionModelId(undefined), false);
});

test("parseFusionModelName extracts mode and inline overrides", () => {
  const a = parseFusionModelName("local-fusion");
  assert.deepEqual(
    { mode: a?.mode, analysis: a?.analysisModels, judge: a?.judgeModel },
    {
      mode: null,
      analysis: null,
      judge: null,
    }
  );

  const b = parseFusionModelName("local-fusion-code");
  assert.equal(b?.mode, "code");

  const c = parseFusionModelName(
    "local-fusion-deep:openai/gpt-4.1+anthropic/claude-sonnet-4.5@anthropic/claude-opus-4.7"
  );
  assert.equal(c?.mode, "deep");
  assert.deepEqual(c?.analysisModels, ["openai/gpt-4.1", "anthropic/claude-sonnet-4.5"]);
  assert.equal(c?.judgeModel, "anthropic/claude-opus-4.7");

  const d = parseFusionModelName("local-fusion@anthropic/claude-opus-4.7");
  assert.equal(d?.mode, null);
  assert.equal(d?.judgeModel, "anthropic/claude-opus-4.7");

  const bad = parseFusionModelName("not-a-fusion-model");
  assert.equal(bad, null);
});

test("local-fusion fans out to N models and synthesizes one fused answer", async () => {
  await seedConnection("openai", { apiKey: "sk-openai-test" });
  await seedConnection("anthropic", { apiKey: "sk-ant-test" });

  setFusionConfig({
    analysisModels: ["anthropic/claude-sonnet-4.5", "openai/gpt-4.1"],
    judgeModel: "anthropic/claude-opus-4.7",
    criticModel: null,
    mode: "balanced",
    enableCritique: false,
    enableCache: false,
    enabled: true,
  });

  const calls: UpstreamCall[] = [];
  const restore = installFetchMock({
    capture: calls,
    byModel: {
      "claude-sonnet-4.5": "sonnet draft about async io",
      "gpt-4.1": "gpt-4.1 draft about async io",
      "claude-opus-4.7": "FUSED-FINAL-ANSWER",
    },
    defaultReply: "fallback",
  });

  try {
    const response = await handleChat(
      buildRequest({
        body: {
          model: "local-fusion",
          messages: [{ role: "user", content: "explain async io" }],
          stream: false,
        },
      })
    );

    assert.equal(response.status, 200);
    const json = (await response.json()) as any;
    assert.equal(json.choices?.[0]?.message?.content, "FUSED-FINAL-ANSWER");
    assert.equal(json.choices?.[0]?.finish_reason, "stop");
    assert.equal(json.x_local_fusion.mode, "balanced");
    assert.deepEqual(json.x_local_fusion.analysis_models, [
      "anthropic/claude-sonnet-4.5",
      "openai/gpt-4.1",
    ]);
    assert.equal(json.x_local_fusion.judge_model, "anthropic/claude-opus-4.7");
    assert.equal(json.x_local_fusion.judge_failed, false);
    assert.equal(json.x_local_fusion.cached, false);

    // Sanity check: at least three upstream models were called (two analysis + judge).
    const uniqueModels = new Set(calls.map((c) => c.model));
    assert.ok(uniqueModels.size >= 3, `expected >=3 upstream models, got ${uniqueModels.size}`);
  } finally {
    restore();
  }
});

test("local-fusion falls back to best candidate when judge fails", async () => {
  await seedConnection("openai", { apiKey: "sk-openai-test" });
  await seedConnection("anthropic", { apiKey: "sk-ant-test" });

  setFusionConfig({
    analysisModels: ["anthropic/claude-sonnet-4.5", "openai/gpt-4.1"],
    judgeModel: "anthropic/claude-opus-4.7",
    criticModel: null,
    enableCritique: false,
    enableCache: false,
    enabled: true,
  });

  // Judge always fails with HTTP 502; one analysis model returns a long answer
  // and should win the fallback.
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any = {}) => {
    let parsed: any = null;
    try {
      parsed = JSON.parse(String(init.body || "{}"));
    } catch {
      parsed = null;
    }
    const model = String(parsed?.model || "");
    if (model.includes("opus")) {
      return new Response(JSON.stringify({ error: { message: "boom" } }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (model.includes("claude-sonnet-4.5") || model.includes("sonnet")) {
      return buildAnthropicResponse(
        "this is the longest candidate by far — it should win the judge fallback because it is the most detailed"
      );
    }
    return buildOpenAIResponse("short gpt answer");
  }) as typeof fetch;

  try {
    const response = await handleChat(
      buildRequest({
        body: {
          model: "local-fusion",
          messages: [{ role: "user", content: "fallback test" }],
          stream: false,
        },
      })
    );
    assert.equal(response.status, 200);
    const json = (await response.json()) as any;
    assert.match(json.choices?.[0]?.message?.content, /longest candidate/);
    assert.equal(json.x_local_fusion.judge_failed, true);
    assert.match(String(json.x_local_fusion.fallback_reason), /claude-sonnet-4\.5/);
  } finally {
    globalThis.fetch = original;
  }
});

test("local-fusion rejects recursive configuration", async () => {
  await seedConnection("openai", { apiKey: "sk-openai-test" });
  setFusionConfig({
    analysisModels: ["local-fusion-fast"], // points back at fusion
    judgeModel: "openai/gpt-4.1",
    enableCritique: false,
    enableCache: false,
  });

  const response = await handleChat(
    buildRequest({
      body: {
        model: "local-fusion",
        messages: [{ role: "user", content: "x" }],
        stream: false,
      },
    })
  );
  assert.equal(response.status, 400);
  const json = (await response.json()) as any;
  assert.match(json.error.message, /local-fusion/);
});

test("local-fusion returns 503 when disabled in config", async () => {
  setFusionConfig({ enabled: false });
  const response = await handleChat(
    buildRequest({
      body: {
        model: "local-fusion",
        messages: [{ role: "user", content: "x" }],
        stream: false,
      },
    })
  );
  assert.equal(response.status, 503);
});

test("inline fusion model name overrides saved config", async () => {
  await seedConnection("openai", { apiKey: "sk-openai-test" });
  await seedConnection("anthropic", { apiKey: "sk-ant-test" });

  // Saved config points at one set of models; inline syntax should override.
  setFusionConfig({
    analysisModels: ["openai/gpt-4.1"],
    judgeModel: "openai/gpt-4.1",
    enableCritique: false,
    enableCache: false,
  });

  const restore = installFetchMock({
    byModel: {
      "claude-sonnet-4.5": "sonnet via inline",
      "gpt-4.1": "gpt via inline",
      "claude-opus-4.7": "INLINE-JUDGE-RESULT",
    },
  });

  try {
    const response = await handleChat(
      buildRequest({
        body: {
          model:
            "local-fusion-code:anthropic/claude-sonnet-4.5+openai/gpt-4.1@anthropic/claude-opus-4.7",
          messages: [{ role: "user", content: "inline" }],
          stream: false,
        },
      })
    );
    assert.equal(response.status, 200);
    const json = (await response.json()) as any;
    assert.equal(json.choices?.[0]?.message?.content, "INLINE-JUDGE-RESULT");
    assert.equal(json.x_local_fusion.mode, "code");
    assert.equal(json.x_local_fusion.judge_model, "anthropic/claude-opus-4.7");
    assert.deepEqual(
      new Set(json.x_local_fusion.analysis_models),
      new Set(["anthropic/claude-sonnet-4.5", "openai/gpt-4.1"])
    );
  } finally {
    restore();
  }
});

test("local-fusion stream=true emits a single fused SSE chunk", async () => {
  await seedConnection("openai", { apiKey: "sk-openai-test" });
  await seedConnection("anthropic", { apiKey: "sk-ant-test" });
  setFusionConfig({
    analysisModels: ["openai/gpt-4.1"],
    judgeModel: "anthropic/claude-opus-4.7",
    enableCritique: false,
    enableCache: false,
  });

  const restore = installFetchMock({
    byModel: {
      "gpt-4.1": "leg",
      "claude-opus-4.7": "STREAMED-FUSED",
    },
  });

  try {
    const response = await handleChat(
      buildRequest({
        body: {
          model: "local-fusion",
          messages: [{ role: "user", content: "stream test" }],
          stream: true,
        },
      })
    );
    assert.equal(response.status, 200);
    assert.match(String(response.headers.get("content-type") || ""), /text\/event-stream/);
    const text = await response.text();
    assert.match(text, /STREAMED-FUSED/);
    assert.match(text, /\[DONE\]/);
  } finally {
    restore();
  }
});
