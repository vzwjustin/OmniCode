// SPDX-License-Identifier: MIT
//
// Hermetic tests for the MCP cloud-agent control plane (7 tools).
//
// These tools wrap the REST endpoints under /api/v1/agents/*; they do
// NOT call JulesAgent / DevinAgent / CodexCloudAgent directly. The
// REST layer owns credential resolution from `provider_connections`.
//
// Mocking pattern mirrors tests/unit/jules-adapter.test.ts — we stub
// global.fetch so the tests are hermetic (no real outbound calls, no
// SQLite required for audit). Audit `logToolCall` fails-soft when the
// SQLite file is missing (see open-sse/mcp-server/audit.ts:179), so we
// don't need to mock it.
//
// Coverage map (12 acceptance cases from the Track-2 spec):
//   01 — list_providers returns the static 3-agent catalog (no fetch)
//   02 — list_tasks issues GET /api/v1/agents/tasks when called without filters
//   03 — list_tasks appends ?provider=&status= when called with filters
//   04 — get_task issues GET /api/v1/agents/tasks/{id}
//   05 — list_sources issues GET /api/v1/agents/sources?provider={id}
//   06 — create_task POSTs /api/v1/agents/tasks with the documented body shape
//   07 — create_task input schema rejects when required fields are missing
//   08 — send_message POSTs /api/v1/agents/tasks/{id} with {action,message}
//   09 — approve_plan POSTs /api/v1/agents/tasks/{id} with {action:'approve'}
//   10 — every tool forwards the caller's API key as `Authorization: Bearer ${key}`
//   11 — 4xx upstream responses surface as descriptive Error throws (no raw dump)
//   12 — scope check: cloud_agent:write tool is rejected with only cloud_agent:read

import test from "node:test";
import assert from "node:assert/strict";

import {
  CLOUD_AGENT_PROVIDERS,
  handleCloudAgentApprovePlan,
  handleCloudAgentCreateTask,
  handleCloudAgentGetTask,
  handleCloudAgentListProviders,
  handleCloudAgentListSources,
  handleCloudAgentListTasks,
  handleCloudAgentSendMessage,
} from "../../open-sse/mcp-server/tools/cloudAgentTools.ts";
import {
  evaluateToolScopes,
  type McpToolExtraLike,
} from "../../open-sse/mcp-server/scopeEnforcement.ts";
import { cloudAgentCreateTaskInput } from "../../open-sse/mcp-server/schemas/tools.ts";

// ---------------------------------------------------------------------------
// fetch mock — same shape as tests/unit/jules-adapter.test.ts
// ---------------------------------------------------------------------------

type CapturedCall = { url: string; init?: RequestInit };

function installFetchMock(
  responder: (url: string, init?: RequestInit) => { status: number; body: unknown }
): { calls: CapturedCall[]; restore: () => void } {
  const original = global.fetch;
  const calls: CapturedCall[] = [];

  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
    calls.push({ url, init });
    const { status, body } = responder(url, init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof global.fetch;

  return {
    calls,
    restore: () => {
      global.fetch = original;
    },
  };
}

// Caller `extra` with a server-attested bearer token. The handlers MUST
// forward this on outbound REST calls — see test #10.
const CALLER_TOKEN = "mcp-caller-bearer-token-abc123";
const extraWithToken: McpToolExtraLike = {
  authInfo: { clientId: "test-client", scopes: ["cloud_agent:read"], token: CALLER_TOKEN },
};

function authHeaderOf(call: CapturedCall): string | undefined {
  const headers = call.init?.headers as Record<string, string> | undefined;
  return headers?.["Authorization"];
}

function bodyOf<T = unknown>(call: CapturedCall): T {
  const raw = call.init?.body;
  if (typeof raw !== "string") {
    throw new Error("Expected outbound request body to be a string");
  }
  return JSON.parse(raw) as T;
}

// ---------------------------------------------------------------------------
// 01 — list_providers returns the static catalog without issuing fetch
// ---------------------------------------------------------------------------

test("list_providers returns the static 3-agent catalog and emits no fetch", async () => {
  const mock = installFetchMock(() => {
    throw new Error("list_providers MUST be a static call — no fetch expected");
  });
  try {
    const result = await handleCloudAgentListProviders({}, extraWithToken);
    assert.equal(result.isError, undefined);
    assert.equal(mock.calls.length, 0);

    assert.ok(result.structuredContent, "structuredContent should be present");
    const payload = result.structuredContent as { providers: Array<{ id: string }> };
    assert.equal(payload.providers.length, 3);
    const ids = payload.providers.map((p) => p.id).sort();
    assert.deepEqual(ids, ["codex-cloud", "devin", "jules"]);

    // Sanity check the exported constant stays in sync.
    assert.equal(CLOUD_AGENT_PROVIDERS.length, 3);
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------------------
// 02 — list_tasks (no filters) → GET /api/v1/agents/tasks (no query string)
// ---------------------------------------------------------------------------

test("list_tasks issues GET /api/v1/agents/tasks (no query) without filters", async () => {
  const mock = installFetchMock(() => ({ status: 200, body: { data: [] } }));
  try {
    await handleCloudAgentListTasks({}, extraWithToken);

    assert.equal(mock.calls.length, 1);
    const call = mock.calls[0];
    assert.equal(call.url, "http://localhost:20128/api/v1/agents/tasks");
    assert.equal(call.init?.method, "GET");
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------------------
// 03 — list_tasks with filters → ?provider=&status=
// ---------------------------------------------------------------------------

test("list_tasks appends ?provider=&status= when filters are supplied", async () => {
  const mock = installFetchMock(() => ({ status: 200, body: { data: [] } }));
  try {
    await handleCloudAgentListTasks(
      { provider: "jules", status: "running", limit: 25 },
      extraWithToken
    );

    assert.equal(mock.calls.length, 1);
    const parsed = new URL(mock.calls[0].url);
    assert.equal(parsed.pathname, "/api/v1/agents/tasks");
    assert.equal(parsed.searchParams.get("provider"), "jules");
    assert.equal(parsed.searchParams.get("status"), "running");
    assert.equal(parsed.searchParams.get("limit"), "25");
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------------------
// 04 — get_task → GET /api/v1/agents/tasks/{id}
// ---------------------------------------------------------------------------

test("get_task issues GET /api/v1/agents/tasks/{id} with the id path-encoded", async () => {
  const mock = installFetchMock(() => ({
    status: 200,
    body: { data: { id: "task_abc", status: "queued" } },
  }));
  try {
    const result = await handleCloudAgentGetTask({ id: "task_abc" }, extraWithToken);

    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].url, "http://localhost:20128/api/v1/agents/tasks/task_abc");
    assert.equal(mock.calls[0].init?.method, "GET");

    // Verify structuredContent passthrough.
    assert.ok(result.structuredContent);
    const payload = result.structuredContent as { data: { id: string } };
    assert.equal(payload.data.id, "task_abc");
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------------------
// 05 — list_sources → GET /api/v1/agents/sources?provider={id}
// ---------------------------------------------------------------------------

test("list_sources issues GET /api/v1/agents/sources with the provider query", async () => {
  const mock = installFetchMock(() => ({ status: 200, body: { sources: [] } }));
  try {
    await handleCloudAgentListSources({ provider: "jules" }, extraWithToken);

    assert.equal(mock.calls.length, 1);
    const parsed = new URL(mock.calls[0].url);
    assert.equal(parsed.pathname, "/api/v1/agents/sources");
    assert.equal(parsed.searchParams.get("provider"), "jules");
    assert.equal(mock.calls[0].init?.method, "GET");
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------------------
// 06 — create_task → POST /api/v1/agents/tasks with the documented body
// ---------------------------------------------------------------------------

test("create_task POSTs /api/v1/agents/tasks with providerId+prompt+source+options", async () => {
  const mock = installFetchMock(() => ({
    status: 201,
    body: { data: { id: "task_new" } },
  }));
  try {
    await handleCloudAgentCreateTask(
      {
        providerId: "jules",
        prompt: "Add a README to the repo.",
        source: {
          repoName: "omniroute",
          repoUrl: "https://github.com/jus2087/omniroute",
          branch: "main",
        },
        options: { autoCreatePr: true },
      },
      extraWithToken
    );

    assert.equal(mock.calls.length, 1);
    const call = mock.calls[0];
    assert.equal(call.url, "http://localhost:20128/api/v1/agents/tasks");
    assert.equal(call.init?.method, "POST");

    const body = bodyOf<{
      providerId: string;
      prompt: string;
      source: { repoName: string; repoUrl: string; branch?: string };
      options: { autoCreatePr: boolean };
    }>(call);
    assert.equal(body.providerId, "jules");
    assert.equal(body.prompt, "Add a README to the repo.");
    assert.equal(body.source.repoName, "omniroute");
    assert.equal(body.source.repoUrl, "https://github.com/jus2087/omniroute");
    assert.equal(body.source.branch, "main");
    assert.equal(body.options.autoCreatePr, true);
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------------------
// 07 — create_task input schema rejects missing required fields
// ---------------------------------------------------------------------------

test("create_task input schema rejects missing required fields (Zod validation)", () => {
  // No prompt, no source → invalid
  const r1 = cloudAgentCreateTaskInput.safeParse({ providerId: "jules" });
  assert.equal(r1.success, false);

  // Missing source.repoUrl → invalid
  const r2 = cloudAgentCreateTaskInput.safeParse({
    providerId: "jules",
    prompt: "do a thing",
    source: { repoName: "omniroute" },
  });
  assert.equal(r2.success, false);

  // Unknown providerId → invalid (enum-restricted)
  const r3 = cloudAgentCreateTaskInput.safeParse({
    providerId: "not-a-real-provider",
    prompt: "do a thing",
    source: { repoName: "omniroute", repoUrl: "https://github.com/o/r" },
  });
  assert.equal(r3.success, false);

  // Fully valid → succeeds
  const r4 = cloudAgentCreateTaskInput.safeParse({
    providerId: "jules",
    prompt: "do a thing",
    source: { repoName: "omniroute", repoUrl: "https://github.com/o/r" },
  });
  assert.equal(r4.success, true);
});

// ---------------------------------------------------------------------------
// 08 — send_message → POST /api/v1/agents/tasks/{id} with {action,message}
// ---------------------------------------------------------------------------

test("send_message POSTs /api/v1/agents/tasks/{id} with action='message' and the message", async () => {
  const mock = installFetchMock(() => ({
    status: 200,
    body: { success: true, data: {} },
  }));
  try {
    await handleCloudAgentSendMessage(
      { id: "task_xyz", message: "Also rename foo to bar" },
      extraWithToken
    );

    assert.equal(mock.calls.length, 1);
    const call = mock.calls[0];
    assert.equal(call.url, "http://localhost:20128/api/v1/agents/tasks/task_xyz");
    assert.equal(call.init?.method, "POST");

    const body = bodyOf<{ action: string; message: string }>(call);
    assert.equal(body.action, "message");
    assert.equal(body.message, "Also rename foo to bar");
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------------------
// 09 — approve_plan → POST /api/v1/agents/tasks/{id} with {action:'approve'}
// ---------------------------------------------------------------------------

test("approve_plan POSTs /api/v1/agents/tasks/{id} with {action:'approve'}", async () => {
  const mock = installFetchMock(() => ({ status: 200, body: { success: true, data: {} } }));
  try {
    await handleCloudAgentApprovePlan({ id: "task_xyz" }, extraWithToken);

    assert.equal(mock.calls.length, 1);
    const call = mock.calls[0];
    assert.equal(call.url, "http://localhost:20128/api/v1/agents/tasks/task_xyz");
    assert.equal(call.init?.method, "POST");

    const body = bodyOf<{ action: string; message?: string }>(call);
    assert.equal(body.action, "approve");
    assert.equal(body.message, undefined, "approve_plan body must not carry a 'message' field");
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------------------
// 10 — every REST-calling tool forwards the caller's API key as Bearer
// ---------------------------------------------------------------------------

test("every REST-calling tool forwards the caller's API key as Authorization: Bearer", async () => {
  const cases: Array<{ name: string; run: () => Promise<unknown> }> = [
    { name: "list_tasks", run: () => handleCloudAgentListTasks({}, extraWithToken) },
    {
      name: "get_task",
      run: () => handleCloudAgentGetTask({ id: "task_abc" }, extraWithToken),
    },
    {
      name: "list_sources",
      run: () => handleCloudAgentListSources({ provider: "jules" }, extraWithToken),
    },
    {
      name: "create_task",
      run: () =>
        handleCloudAgentCreateTask(
          {
            providerId: "devin",
            prompt: "task",
            source: { repoName: "r", repoUrl: "https://github.com/o/r" },
          },
          extraWithToken
        ),
    },
    {
      name: "send_message",
      run: () => handleCloudAgentSendMessage({ id: "task_abc", message: "hi" }, extraWithToken),
    },
    {
      name: "approve_plan",
      run: () => handleCloudAgentApprovePlan({ id: "task_abc" }, extraWithToken),
    },
  ];

  for (const c of cases) {
    const mock = installFetchMock(() => ({ status: 200, body: { ok: true } }));
    try {
      await c.run();
      assert.equal(mock.calls.length, 1, `${c.name}: expected exactly 1 outbound call`);
      assert.equal(
        authHeaderOf(mock.calls[0]),
        `Bearer ${CALLER_TOKEN}`,
        `${c.name}: outbound Authorization must be 'Bearer <callerToken>'`
      );
    } finally {
      mock.restore();
    }
  }
});

// ---------------------------------------------------------------------------
// 11 — 4xx upstream surfaces as a descriptive Error (sanitized, no raw dump)
// ---------------------------------------------------------------------------

test("4xx upstream surfaces as descriptive Error without leaking raw body", async () => {
  // Mimic the {error: "..."} envelope the REST routes produce. We want
  // the message extracted, NOT a raw JSON.stringify of the body.
  const mock = installFetchMock(() => ({
    status: 400,
    body: {
      error: "No active credentials configured for cloud agent provider: jules",
      details: { secretField: "should-not-appear-in-error-message" },
    },
  }));
  try {
    const result = await handleCloudAgentCreateTask(
      {
        providerId: "jules",
        prompt: "x",
        source: { repoName: "r", repoUrl: "https://github.com/o/r" },
      },
      extraWithToken
    );

    // Handler returns an isError result rather than throwing — the user-
    // facing message goes in content[0].text.
    assert.equal(result.isError, true);
    const text = (result.content[0] as { text: string }).text;
    assert.ok(text.startsWith("Error: "), `expected human-readable prefix, got: ${text}`);
    assert.ok(text.includes("400"), `expected status code in message, got: ${text}`);
    assert.ok(
      text.includes("No active credentials configured"),
      `expected sanitized upstream error to be surfaced, got: ${text}`
    );
    // Defense-in-depth: do NOT leak adjacent fields.
    assert.equal(
      text.includes("secretField"),
      false,
      "raw upstream body MUST NOT be dumped into the error message"
    );
    assert.equal(
      text.includes("should-not-appear-in-error-message"),
      false,
      "raw upstream body values MUST NOT be dumped"
    );
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------------------
// 12 — scope check: cloud_agent:write tools reject a cloud_agent:read-only key
// ---------------------------------------------------------------------------

test("cloud_agent:write tool is rejected when caller only has cloud_agent:read", () => {
  // create_task / send_message / approve_plan all require cloud_agent:write.
  const writeTools = [
    "omniroute_cloud_agent_create_task",
    "omniroute_cloud_agent_send_message",
    "omniroute_cloud_agent_approve_plan",
  ];

  for (const toolName of writeTools) {
    const check = evaluateToolScopes(toolName, ["cloud_agent:read"], true);
    assert.equal(check.allowed, false, `${toolName}: expected scope check to deny`);
    assert.equal(check.reason, "missing_scopes", `${toolName}: expected reason=missing_scopes`);
    assert.ok(
      check.missing.includes("cloud_agent:write"),
      `${toolName}: expected missing cloud_agent:write`
    );
  }

  // Read tools accept cloud_agent:read (positive control).
  const readTools = [
    "omniroute_cloud_agent_list_providers",
    "omniroute_cloud_agent_list_tasks",
    "omniroute_cloud_agent_get_task",
    "omniroute_cloud_agent_list_sources",
  ];
  for (const toolName of readTools) {
    const check = evaluateToolScopes(toolName, ["cloud_agent:read"], true);
    assert.equal(check.allowed, true, `${toolName}: expected scope check to allow`);
  }

  // Wildcard "*" grants everything (defensive — keeps consistent with the
  // existing scopeMatches semantics; see tests/unit/t08-mcp-scope-enforcement.test.ts).
  for (const toolName of writeTools) {
    const check = evaluateToolScopes(toolName, ["*"], true);
    assert.equal(check.allowed, true, `${toolName}: wildcard should grant`);
  }
});
