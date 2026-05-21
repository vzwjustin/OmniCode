import test from "node:test";
import assert from "node:assert/strict";

import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";

const harness = await createChatPipelineHarness("local-cli-unit");
const { BaseExecutor, buildRequest, handleChat, resetStorage, seedConnection } = harness;

const { setFusionConfig, resetFusionConfig } = await import("../../src/lib/db/fusionConfig.ts");
const { isLocalCliModelId, listLocalCliModelNames } =
  await import("../../open-sse/handlers/localCli.ts");
const { clearFusionCache } = await import("../../open-sse/handlers/fusion.ts");

const PYTHON = process.execPath
  ? process.execPath.replace(/\/node$/, "/python3")
  : "/usr/bin/python3";

// Resolve a working python interpreter for the test harness.
async function findPython(): Promise<string> {
  const candidates = ["/usr/local/bin/python3", "/usr/bin/python3", "/opt/homebrew/bin/python3"];
  const fs = await import("node:fs");
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* ignore */
    }
  }
  return "python3";
}

const PY = await findPython();

function resetEnv() {
  process.env.REQUIRE_API_KEY = "false";
  delete process.env.INPUT_SANITIZER_ENABLED;
  delete process.env.INPUT_SANITIZER_MODE;
  delete process.env.PII_REDACTION_ENABLED;
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

test("isLocalCliModelId recognizes only known local: ids", () => {
  assert.equal(isLocalCliModelId("local:claude-code"), true);
  assert.equal(isLocalCliModelId("local:claude"), true);
  assert.equal(isLocalCliModelId("local:codex"), true);
  assert.equal(isLocalCliModelId("local:gemini"), true);
  assert.equal(isLocalCliModelId("local:something-unknown"), false);
  assert.equal(isLocalCliModelId("anthropic/claude-opus-4.1"), false);
  assert.equal(isLocalCliModelId(""), false);
  assert.equal(isLocalCliModelId(undefined as any), false);
});

test("listLocalCliModelNames reflects configured adapters only", () => {
  resetFusionConfig();
  assert.deepEqual(listLocalCliModelNames(), []);
  setFusionConfig({
    localCli: {
      claudeCode: { cmd: PY, args: ["-c", "print('hi')"] },
      codex: { cmd: "", args: [] },
      gemini: { cmd: PY, args: ["-c", "print('hi')"] },
      timeoutMs: 30_000,
    },
  });
  const ids = listLocalCliModelNames();
  assert.ok(ids.includes("local:claude-code"));
  assert.ok(ids.includes("local:gemini"));
  assert.ok(!ids.includes("local:codex"));
});

test("local:claude-code (unconfigured) returns 503 with helpful message", async () => {
  resetFusionConfig();
  const response = await handleChat(
    buildRequest({
      body: {
        model: "local:claude-code",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      },
    })
  );
  assert.equal(response.status, 503);
  const json = (await response.json()) as any;
  assert.match(json.error.message, /not configured/i);
});

test("local:claude-code runs the configured binary and returns its stdout", async () => {
  // Stand-in CLI: echo whatever arrives on stdin with a marker prefix.
  const script =
    "import sys; data = sys.stdin.read(); sys.stdout.write('CLAUDE-CODE-OUT:' + data.strip().splitlines()[-1])";

  setFusionConfig({
    localCli: {
      claudeCode: { cmd: PY, args: ["-c", script] },
      codex: { cmd: "", args: [] },
      gemini: { cmd: "", args: [] },
      timeoutMs: 30_000,
    },
  });

  const response = await handleChat(
    buildRequest({
      body: {
        model: "local:claude-code",
        messages: [{ role: "user", content: "hello-from-test" }],
        stream: false,
      },
    })
  );
  assert.equal(response.status, 200);
  const json = (await response.json()) as any;
  const content = json.choices?.[0]?.message?.content || "";
  assert.match(content, /CLAUDE-CODE-OUT:/);
  assert.match(content, /hello-from-test/);
  assert.equal(json.x_local_cli.source, "local-cli");
});

test("local CLI non-zero exit returns 502 with stderr tail", async () => {
  setFusionConfig({
    localCli: {
      claudeCode: { cmd: "", args: [] },
      codex: {
        cmd: PY,
        args: ["-c", "import sys; sys.stderr.write('kaboom from codex stub'); sys.exit(7)"],
      },
      gemini: { cmd: "", args: [] },
      timeoutMs: 30_000,
    },
  });
  const response = await handleChat(
    buildRequest({
      body: {
        model: "local:codex",
        messages: [{ role: "user", content: "x" }],
        stream: false,
      },
    })
  );
  assert.equal(response.status, 502);
  const json = (await response.json()) as any;
  assert.match(json.error.message, /exited with code 7/);
});

test("local CLI streaming mode emits the captured output as a single SSE chunk", async () => {
  setFusionConfig({
    localCli: {
      claudeCode: { cmd: "", args: [] },
      codex: { cmd: "", args: [] },
      gemini: {
        cmd: PY,
        args: ["-c", "import sys; sys.stdout.write('GEMINI-STREAM-OUT')"],
      },
      timeoutMs: 30_000,
    },
  });
  const response = await handleChat(
    buildRequest({
      body: {
        model: "local:gemini",
        messages: [{ role: "user", content: "stream me" }],
        stream: true,
      },
    })
  );
  assert.equal(response.status, 200);
  assert.match(String(response.headers.get("content-type") || ""), /text\/event-stream/);
  const text = await response.text();
  assert.match(text, /GEMINI-STREAM-OUT/);
  assert.match(text, /\[DONE\]/);
});

test("fusion can use local CLIs as analysis models with a remote judge", async () => {
  await seedConnection("anthropic", { apiKey: "sk-ant-test" });
  setFusionConfig({
    analysisModels: ["local:claude-code", "local:codex"],
    judgeModel: "anthropic/claude-opus-4.1",
    criticModel: null,
    enableCritique: false,
    enableCache: false,
    enabled: true,
    localCli: {
      claudeCode: {
        cmd: PY,
        args: ["-c", "import sys; sys.stdout.write('claude-leg-says-hi')"],
      },
      codex: {
        cmd: PY,
        args: ["-c", "import sys; sys.stdout.write('codex-leg-says-hi')"],
      },
      gemini: { cmd: "", args: [] },
      timeoutMs: 30_000,
    },
  });

  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any = {}) => {
    let parsed: any = null;
    try {
      parsed = JSON.parse(String(init.body || "{}"));
    } catch {
      parsed = null;
    }
    const model = String(parsed?.model || "");
    if (model.includes("opus") || model.includes("anthropic")) {
      return new Response(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "REMOTE-JUDGE-FUSED" }],
          model: "claude-opus-4.1",
          stop_reason: "end_turn",
          usage: { input_tokens: 4, output_tokens: 8 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("not used", { status: 200, headers: { "Content-Type": "text/plain" } });
  }) as typeof fetch;

  try {
    const response = await handleChat(
      buildRequest({
        body: {
          model: "local-fusion",
          messages: [{ role: "user", content: "hybrid run" }],
          stream: false,
        },
      })
    );
    assert.equal(response.status, 200);
    const json = (await response.json()) as any;
    assert.equal(json.choices?.[0]?.message?.content, "REMOTE-JUDGE-FUSED");
    assert.deepEqual(json.x_local_fusion.analysis_models, ["local:claude-code", "local:codex"]);
    assert.equal(json.x_local_fusion.judge_model, "anthropic/claude-opus-4.1");
    assert.equal(json.x_local_fusion.judge_failed, false);
  } finally {
    globalThis.fetch = original;
  }
});

test("fully-local fusion: local CLI analysis + local CLI judge, zero network calls", async () => {
  setFusionConfig({
    analysisModels: ["local:claude-code", "local:codex"],
    judgeModel: "local:gemini",
    criticModel: null,
    enableCritique: false,
    enableCache: false,
    enabled: true,
    localCli: {
      claudeCode: {
        cmd: PY,
        args: ["-c", "import sys; sys.stdout.write('claude draft')"],
      },
      codex: {
        cmd: PY,
        args: ["-c", "import sys; sys.stdout.write('codex draft')"],
      },
      gemini: {
        cmd: PY,
        args: [
          "-c",
          "import sys; data = sys.stdin.read(); sys.stdout.write('FULLY-LOCAL:' + str(len(data)))",
        ],
      },
      timeoutMs: 30_000,
    },
  });

  // Trip any accidental remote calls.
  const original = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = (async (..._args: any[]) => {
    networkCalls += 1;
    return new Response("nope", { status: 599 });
  }) as typeof fetch;

  try {
    const response = await handleChat(
      buildRequest({
        body: {
          model: "local-fusion",
          messages: [{ role: "user", content: "fully local" }],
          stream: false,
        },
      })
    );
    assert.equal(response.status, 200);
    assert.equal(networkCalls, 0, "fully-local fusion must not make network calls");
    const json = (await response.json()) as any;
    const answer: string = json.choices?.[0]?.message?.content || "";
    assert.match(answer, /^FULLY-LOCAL:/);
    assert.equal(json.x_local_fusion.judge_model, "local:gemini");
  } finally {
    globalThis.fetch = original;
  }
});
