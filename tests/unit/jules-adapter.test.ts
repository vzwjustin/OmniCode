// SPDX-License-Identifier: MIT
//
// Wire-contract tests for the Jules cloud-agent adapter.
//
// The previous adapter was written speculatively against a guessed API shape
// and shipped broken for ~every call (see commit 6b64ddba). These tests pin
// the rewrite against the published v1alpha contract:
//   https://developers.google.com/jules/api
//
// We mock global.fetch so the tests are hermetic — no real Jules API calls,
// no quota burn. The mocks capture the exact URL / headers / body the
// adapter emits, then we assert against the documented schema.

import { test } from "node:test";
import assert from "node:assert/strict";
import { JulesAgent } from "../../src/lib/cloudAgent/agents/jules.ts";
import type { AgentCredentials, CreateTaskParams } from "../../src/lib/cloudAgent/baseAgent.ts";

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

const creds: AgentCredentials = { apiKey: "test-key" };

function makeParams(overrides?: Partial<CreateTaskParams>): CreateTaskParams {
  return {
    prompt: "Add a README",
    source: {
      repoName: "repo",
      repoUrl: "https://github.com/owner/repo",
      branch: "main",
    },
    options: {},
    ...overrides,
  };
}

test("createTask emits the documented Jules sourceContext envelope", async () => {
  const mock = installFetchMock(() => ({
    status: 200,
    body: { name: "sessions/abc123", id: "abc123" },
  }));
  try {
    const agent = new JulesAgent();
    const task = await agent.createTask(makeParams(), creds);

    assert.equal(mock.calls.length, 1);
    const call = mock.calls[0];
    assert.equal(call.url, "https://jules.googleapis.com/v1alpha/sessions");
    assert.equal(call.init?.method, "POST");

    const headers = call.init?.headers as Record<string, string>;
    assert.equal(headers["X-Goog-Api-Key"], "test-key");
    assert.equal(headers["Content-Type"], "application/json");
    // Critical: never send Authorization: Bearer — Jules rejects it.
    assert.equal(headers["Authorization"], undefined);

    const body = JSON.parse(call.init?.body as string);
    // The Jules-documented envelope shape (see docs link at top of file).
    assert.deepEqual(body.sourceContext, {
      source: "sources/github/owner/repo",
      githubRepoContext: { startingBranch: "main" },
    });
    assert.equal(body.prompt, "Add a README");
    // Speculative pre-rewrite fields MUST NOT appear.
    assert.equal(body.source, undefined);
    assert.equal(body.branch, undefined);

    // externalId is taken from data.id when present.
    assert.equal(task.externalId, "abc123");
    assert.equal(task.status, "queued");
  } finally {
    mock.restore();
  }
});

test("createTask falls back to parsing sessions/<id> from data.name", async () => {
  const mock = installFetchMock(() => ({
    status: 200,
    body: { name: "sessions/fallback-id" }, // no .id field
  }));
  try {
    const agent = new JulesAgent();
    const task = await agent.createTask(makeParams(), creds);
    assert.equal(task.externalId, "fallback-id");
  } finally {
    mock.restore();
  }
});

test("createTask throws a clear error for non-GitHub repoUrl values", async () => {
  const mock = installFetchMock(() => ({ status: 200, body: {} }));
  try {
    const agent = new JulesAgent();
    await assert.rejects(
      () =>
        agent.createTask(
          makeParams({
            source: { repoName: "repo", repoUrl: "not-a-url", branch: "main" },
          }),
          creds
        ),
      /unable to parse a GitHub owner/
    );
    // No request should have been issued.
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test("createTask accepts .git suffix and SSH-shorthand repo URLs", async () => {
  const variants = [
    "https://github.com/owner/repo.git",
    "https://github.com/owner/repo/",
    "git@github.com:owner/repo.git",
    "git@github.com:owner/repo",
  ];
  for (const repoUrl of variants) {
    const mock = installFetchMock(() => ({
      status: 200,
      body: { name: "sessions/x", id: "x" },
    }));
    try {
      const agent = new JulesAgent();
      await agent.createTask(makeParams({ source: { repoName: "repo", repoUrl } }), creds);
      const body = JSON.parse(mock.calls[0].init?.body as string);
      assert.equal(body.sourceContext.source, "sources/github/owner/repo", `failed for ${repoUrl}`);
    } finally {
      mock.restore();
    }
  }
});

test("createTask opt-ins: autoCreatePr + planApprovalRequired only when set", async () => {
  const captured: unknown[] = [];
  const mock = installFetchMock((_, init) => {
    captured.push(JSON.parse(init?.body as string));
    return { status: 200, body: { name: "sessions/x", id: "x" } };
  });
  try {
    const agent = new JulesAgent();
    await agent.createTask(makeParams({ options: {} }), creds);
    await agent.createTask(makeParams({ options: { autoCreatePr: true } }), creds);
    await agent.createTask(
      makeParams({ options: { autoCreatePr: true, planApprovalRequired: true } }),
      creds
    );

    const [b1, b2, b3] = captured as Array<Record<string, unknown>>;
    assert.equal(b1.automationMode, undefined);
    assert.equal(b1.requirePlanApproval, undefined);

    assert.equal(b2.automationMode, "AUTO_CREATE_PR");
    assert.equal(b2.requirePlanApproval, undefined);

    assert.equal(b3.automationMode, "AUTO_CREATE_PR");
    assert.equal(b3.requirePlanApproval, true);
  } finally {
    mock.restore();
  }
});

test("getStatus issues parallel calls to /sessions/{id} and /sessions/{id}/activities", async () => {
  const mock = installFetchMock((url) => {
    if (url.endsWith("/sessions/abc")) {
      return {
        status: 200,
        body: {
          name: "sessions/abc",
          outputs: [
            {
              pullRequest: {
                url: "https://github.com/o/r/pull/1",
                title: "feat: add",
                description: "summary",
              },
            },
          ],
        },
      };
    }
    if (url.endsWith("/sessions/abc/activities?pageSize=100")) {
      return {
        status: 200,
        body: {
          activities: [
            {
              id: "a1",
              createTime: "2026-01-01T00:00:00Z",
              planGenerated: { plan: { steps: [{ title: "Step one" }, { title: "Step two" }] } },
            },
            {
              id: "a2",
              createTime: "2026-01-01T00:01:00Z",
              planApproved: {},
            },
            {
              id: "a3",
              createTime: "2026-01-01T00:02:00Z",
              sessionCompleted: {},
            },
          ],
        },
      };
    }
    return { status: 404, body: { error: "not found" } };
  });
  try {
    const agent = new JulesAgent();
    const result = await agent.getStatus("abc", creds);

    // Two URLs hit, both with the correct header.
    assert.equal(mock.calls.length, 2);
    for (const call of mock.calls) {
      assert.equal((call.init?.headers as Record<string, string>)["X-Goog-Api-Key"], "test-key");
    }

    // Status derives to "completed" because sessionCompleted activity is present.
    assert.equal(result.status, "completed");

    // PR fields read from outputs[].pullRequest, NOT from the speculative
    // pre-rewrite outputs.prUrl path.
    assert.deepEqual(result.result, {
      prUrl: "https://github.com/o/r/pull/1",
      commitMessage: "feat: add",
      summary: "summary",
    });

    // Activities mapped correctly: plan-generated → "plan", plan-approved → "plan",
    // session-completed → "completion".
    assert.equal(result.activities.length, 3);
    assert.equal(result.activities[0].type, "plan");
    assert.equal(result.activities[0].content, "1. Step one\n2. Step two");
    assert.equal(result.activities[1].type, "plan");
    assert.equal(result.activities[2].type, "completion");
  } finally {
    mock.restore();
  }
});

test("getStatus derives 'awaiting_approval' when plan generated but not approved", async () => {
  const mock = installFetchMock((url) => {
    if (url.endsWith("/sessions/abc")) return { status: 200, body: { name: "sessions/abc" } };
    return {
      status: 200,
      body: {
        activities: [{ id: "a", createTime: "2026-01-01T00:00:00Z", planGenerated: { plan: {} } }],
      },
    };
  });
  try {
    const agent = new JulesAgent();
    const result = await agent.getStatus("abc", creds);
    assert.equal(result.status, "awaiting_approval");
  } finally {
    mock.restore();
  }
});

test("getStatus derives 'failed' on error activity without sessionCompleted", async () => {
  const mock = installFetchMock((url) => {
    if (url.endsWith("/sessions/abc")) return { status: 200, body: { name: "sessions/abc" } };
    return {
      status: 200,
      body: {
        activities: [
          {
            id: "e",
            createTime: "2026-01-01T00:00:00Z",
            error: { message: "Something broke" },
          },
        ],
      },
    };
  });
  try {
    const agent = new JulesAgent();
    const result = await agent.getStatus("abc", creds);
    assert.equal(result.status, "failed");
    assert.equal(result.activities[0].type, "error");
    assert.equal(result.activities[0].content, "Something broke");
  } finally {
    mock.restore();
  }
});

test("getStatus tolerates a failing /activities endpoint (non-fatal)", async () => {
  const mock = installFetchMock((url) => {
    if (url.endsWith("/sessions/abc"))
      return { status: 200, body: { name: "sessions/abc", outputs: [] } };
    return { status: 500, body: { error: "transient" } };
  });
  try {
    const agent = new JulesAgent();
    const result = await agent.getStatus("abc", creds);
    // Falls back to "queued" with empty activities — does NOT throw.
    assert.equal(result.status, "queued");
    assert.deepEqual(result.activities, []);
  } finally {
    mock.restore();
  }
});

test("sendMessage sends { prompt } (not { message })", async () => {
  const mock = installFetchMock(() => ({ status: 200, body: {} }));
  try {
    const agent = new JulesAgent();
    const activity = await agent.sendMessage("abc", "hello", creds);

    assert.equal(
      mock.calls[0].url,
      "https://jules.googleapis.com/v1alpha/sessions/abc:sendMessage"
    );
    const body = JSON.parse(mock.calls[0].init?.body as string);
    assert.equal(body.prompt, "hello");
    assert.equal(body.message, undefined);

    // Synthetic user-echo activity so the UI has an immediate render.
    assert.equal(activity.type, "message");
    assert.equal(activity.content, "hello");
  } finally {
    mock.restore();
  }
});

test("approvePlan POSTs to :approvePlan with no body", async () => {
  const mock = installFetchMock(() => ({ status: 200, body: {} }));
  try {
    const agent = new JulesAgent();
    await agent.approvePlan("abc", creds);

    assert.equal(
      mock.calls[0].url,
      "https://jules.googleapis.com/v1alpha/sessions/abc:approvePlan"
    );
    assert.equal(mock.calls[0].init?.method, "POST");
    assert.equal(mock.calls[0].init?.body, undefined);
  } finally {
    mock.restore();
  }
});

test("listSources parses the v1alpha sources response schema", async () => {
  const mock = installFetchMock(() => ({
    status: 200,
    body: {
      sources: [
        {
          name: "sources/github/owner/repo",
          githubRepo: {
            owner: "owner",
            repo: "repo",
            defaultBranch: { displayName: "main" },
          },
        },
        // Malformed entry: missing owner -> must be filtered out, NOT returned
        // with empty fields.
        {
          name: "sources/github/bad",
          githubRepo: { repo: "x" },
        },
      ],
    },
  }));
  try {
    const agent = new JulesAgent();
    const sources = await agent.listSources(creds);
    assert.equal(sources.length, 1);
    assert.deepEqual(sources[0], {
      name: "sources/github/owner/repo",
      url: "https://github.com/owner/repo",
      branch: "main",
    });
  } finally {
    mock.restore();
  }
});

test("non-2xx responses surface as descriptive errors", async () => {
  const mock = installFetchMock(() => ({
    status: 401,
    body: {
      error: { code: 401, message: "CREDENTIALS_MISSING", status: "UNAUTHENTICATED" },
    },
  }));
  try {
    const agent = new JulesAgent();
    await assert.rejects(
      () => agent.createTask(makeParams(), creds),
      /Jules create task failed: 401/
    );
  } finally {
    mock.restore();
  }
});
