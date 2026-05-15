/**
 * OmniRoute MCP — Cloud-Agent Tools.
 *
 * Exposes the cloud-agent control plane (Jules / Devin / Codex Cloud)
 * over MCP so clients like Claude Code or Cursor can ask
 *   "start a Jules task on owner/repo to update the README"
 * the same way they already ask "what's my quota".
 *
 * Each tool proxies to the existing REST endpoints under
 * `/api/v1/agents/...`. That layer owns:
 *   - credential resolution from the encrypted `provider_connections`
 *     table (see `getCloudAgentCredentials()`)
 *   - per-provider request shaping (Jules v1alpha, Devin, Codex Cloud)
 *   - upstream auth refresh / retry
 *
 * Going through REST instead of calling `JulesAgent` / `DevinAgent` /
 * `CodexCloudAgent` directly avoids duplicating that infrastructure
 * and keeps a single failure surface.
 *
 * Scopes:
 *   cloud_agent:read   list/get/inspect tasks and sources (4 tools)
 *   cloud_agent:write  create tasks, send messages, approve plans (3 tools)
 *
 * Scope enforcement happens upstream of these handlers via
 * `withScopeEnforcement()` in `server.ts`; this file just emits the
 * outbound REST call.
 */

import { logToolCall } from "../audit.ts";
import { resolveOmniRouteBaseUrl } from "../../../src/shared/utils/resolveOmniRouteBaseUrl.ts";
import type { McpToolExtraLike } from "../scopeEnforcement.ts";

// ============ Provider catalog ============
//
// Mirrors `CLOUD_AGENTS` in
// src/app/(dashboard)/dashboard/cloud-agents/page.tsx so the MCP catalog
// stays in lockstep with the UI. If you add a new cloud-agent provider,
// update both lists (and `src/lib/cloudAgent/registry.ts`).

export const CLOUD_AGENT_PROVIDERS = [
  {
    id: "jules",
    name: "Jules",
    provider: "Google",
    description: "Google's autonomous coding agent",
  },
  {
    id: "devin",
    name: "Devin",
    provider: "Cognition",
    description: "Cognition's AI software engineer",
  },
  {
    id: "codex-cloud",
    name: "Codex Cloud",
    provider: "OpenAI",
    description: "OpenAI's cloud-based coding agent",
  },
] as const;

// ============ Shared types ============

type JsonRecord = Record<string, unknown>;

type CloudAgentToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: JsonRecord;
  isError?: boolean;
};

// ============ Helpers ============

/**
 * Resolve the caller's bearer token. Order of precedence:
 *   1. The token attached to `extra.authInfo.token` (server-attested by
 *      the MCP transport's auth layer, e.g. OAuth bearer on HTTP).
 *   2. The server-side `OMNIROUTE_API_KEY` env var (used by stdio /
 *      local-IDE flows where the transport doesn't carry auth).
 * Returns an empty string when no token is available — the REST layer
 * then handles 401 itself and we surface a clean error.
 */
function resolveCallerToken(extra?: McpToolExtraLike): string {
  const tokenFromAuthInfo = extra?.authInfo?.token;
  if (typeof tokenFromAuthInfo === "string" && tokenFromAuthInfo.trim().length > 0) {
    return tokenFromAuthInfo.trim();
  }
  const envToken = process.env.OMNIROUTE_API_KEY;
  if (typeof envToken === "string" && envToken.trim().length > 0) {
    return envToken.trim();
  }
  return "";
}

function resolveBaseUrl(): string {
  // Honor `OMNIROUTE_BASE_URL` / `BASE_URL` (production) but fall back to
  // localhost on the same port the Next.js server is listening on. Spec:
  // http://localhost:${process.env.PORT || 20128}.
  const fromShared = resolveOmniRouteBaseUrl();
  if (fromShared) return fromShared;
  const port = process.env.PORT?.trim() || "20128";
  return `http://localhost:${port}`;
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sanitizeUpstreamError(rawBody: string, status: number): string {
  // Try JSON-shaped { error: "..." } first; otherwise truncate.
  // We deliberately never embed `err.stack` or unbounded body content —
  // see docs/security/ERROR_SANITIZATION.md.
  let message = "";
  const trimmed = rawBody.trim();
  if (trimmed.length > 0) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed) && typeof parsed.error === "string") {
        message = parsed.error;
      }
    } catch {
      // non-JSON body — keep empty so we don't leak raw payload
    }
  }

  const cleaned = message
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, 200);

  if (cleaned) {
    return `Cloud agent REST call failed (${status}): ${cleaned}`;
  }
  return `Cloud agent REST call failed (${status})`;
}

async function callRestEndpoint(
  path: string,
  init: RequestInit,
  callerToken: string
): Promise<unknown> {
  const url = `${resolveBaseUrl()}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(callerToken ? { Authorization: `Bearer ${callerToken}` } : {}),
    ...((init.headers as Record<string, string>) || {}),
  };
  const response = await fetch(url, {
    ...init,
    headers,
    signal: init.signal || AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    let body = "";
    try {
      body = await response.text();
    } catch {
      // ignore — message will be status-only
    }
    throw new Error(sanitizeUpstreamError(body, response.status));
  }

  // 204 No Content (or empty body) — return null rather than throwing on parse.
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Non-JSON 2xx body — return the raw text so callers can surface it.
    return { raw: text };
  }
}

function structuredResult(payload: JsonRecord): CloudAgentToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function errorResult(err: unknown): CloudAgentToolResult {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: `Error: ${msg}` }],
    isError: true,
  };
}

function toRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

// ============ Handlers ============

export async function handleCloudAgentListProviders(
  args: Record<string, never> = {},
  _extra?: McpToolExtraLike
): Promise<CloudAgentToolResult> {
  const start = Date.now();
  try {
    // Static catalog — no outbound API call.
    const payload = {
      providers: CLOUD_AGENT_PROVIDERS.map((agent) => ({ ...agent })),
    };
    await logToolCall(
      "omniroute_cloud_agent_list_providers",
      args,
      { providerCount: payload.providers.length },
      Date.now() - start,
      true
    );
    return structuredResult(payload);
  } catch (err) {
    await logToolCall(
      "omniroute_cloud_agent_list_providers",
      args,
      null,
      Date.now() - start,
      false,
      err instanceof Error ? err.message : String(err)
    );
    return errorResult(err);
  }
}

export async function handleCloudAgentListTasks(
  args: { provider?: string; status?: string; limit?: number },
  extra?: McpToolExtraLike
): Promise<CloudAgentToolResult> {
  const start = Date.now();
  try {
    const params = new URLSearchParams();
    if (args.provider) params.set("provider", args.provider);
    if (args.status) params.set("status", args.status);
    if (typeof args.limit === "number") params.set("limit", String(args.limit));
    const qs = params.toString();
    const path = qs ? `/api/v1/agents/tasks?${qs}` : `/api/v1/agents/tasks`;

    const raw = await callRestEndpoint(path, { method: "GET" }, resolveCallerToken(extra));
    const payload = { ...toRecord(raw) };
    await logToolCall("omniroute_cloud_agent_list_tasks", args, payload, Date.now() - start, true);
    return structuredResult(payload);
  } catch (err) {
    await logToolCall(
      "omniroute_cloud_agent_list_tasks",
      args,
      null,
      Date.now() - start,
      false,
      err instanceof Error ? err.message : String(err)
    );
    return errorResult(err);
  }
}

export async function handleCloudAgentGetTask(
  args: { id: string },
  extra?: McpToolExtraLike
): Promise<CloudAgentToolResult> {
  const start = Date.now();
  try {
    const path = `/api/v1/agents/tasks/${encodeURIComponent(args.id)}`;
    const raw = await callRestEndpoint(path, { method: "GET" }, resolveCallerToken(extra));
    const payload = { ...toRecord(raw) };
    await logToolCall("omniroute_cloud_agent_get_task", args, payload, Date.now() - start, true);
    return structuredResult(payload);
  } catch (err) {
    await logToolCall(
      "omniroute_cloud_agent_get_task",
      args,
      null,
      Date.now() - start,
      false,
      err instanceof Error ? err.message : String(err)
    );
    return errorResult(err);
  }
}

export async function handleCloudAgentListSources(
  args: { provider: string },
  extra?: McpToolExtraLike
): Promise<CloudAgentToolResult> {
  const start = Date.now();
  try {
    const path = `/api/v1/agents/sources?provider=${encodeURIComponent(args.provider)}`;
    const raw = await callRestEndpoint(path, { method: "GET" }, resolveCallerToken(extra));
    const payload = { ...toRecord(raw) };
    await logToolCall(
      "omniroute_cloud_agent_list_sources",
      args,
      payload,
      Date.now() - start,
      true
    );
    return structuredResult(payload);
  } catch (err) {
    await logToolCall(
      "omniroute_cloud_agent_list_sources",
      args,
      null,
      Date.now() - start,
      false,
      err instanceof Error ? err.message : String(err)
    );
    return errorResult(err);
  }
}

export interface CloudAgentCreateTaskArgs {
  providerId: string;
  prompt: string;
  source: {
    repoName: string;
    repoUrl: string;
    branch?: string;
  };
  options?: {
    autoCreatePr?: boolean;
    planApprovalRequired?: boolean;
    environment?: Record<string, string>;
  };
}

export async function handleCloudAgentCreateTask(
  args: CloudAgentCreateTaskArgs,
  extra?: McpToolExtraLike
): Promise<CloudAgentToolResult> {
  const start = Date.now();
  try {
    const body: JsonRecord = {
      providerId: args.providerId,
      prompt: args.prompt,
      source: {
        repoName: args.source.repoName,
        repoUrl: args.source.repoUrl,
        ...(args.source.branch ? { branch: args.source.branch } : {}),
      },
    };
    if (args.options && Object.keys(args.options).length > 0) {
      body.options = { ...args.options };
    }

    const raw = await callRestEndpoint(
      "/api/v1/agents/tasks",
      {
        method: "POST",
        body: JSON.stringify(body),
      },
      resolveCallerToken(extra)
    );
    const payload = { ...toRecord(raw) };
    await logToolCall(
      "omniroute_cloud_agent_create_task",
      { providerId: args.providerId, promptLength: args.prompt.length },
      payload,
      Date.now() - start,
      true
    );
    return structuredResult(payload);
  } catch (err) {
    await logToolCall(
      "omniroute_cloud_agent_create_task",
      { providerId: args.providerId },
      null,
      Date.now() - start,
      false,
      err instanceof Error ? err.message : String(err)
    );
    return errorResult(err);
  }
}

export async function handleCloudAgentSendMessage(
  args: { id: string; message: string },
  extra?: McpToolExtraLike
): Promise<CloudAgentToolResult> {
  const start = Date.now();
  try {
    const path = `/api/v1/agents/tasks/${encodeURIComponent(args.id)}`;
    const raw = await callRestEndpoint(
      path,
      {
        method: "POST",
        body: JSON.stringify({ action: "message", message: args.message }),
      },
      resolveCallerToken(extra)
    );
    const payload = { ...toRecord(raw) };
    await logToolCall(
      "omniroute_cloud_agent_send_message",
      { id: args.id, messageLength: args.message.length },
      payload,
      Date.now() - start,
      true
    );
    return structuredResult(payload);
  } catch (err) {
    await logToolCall(
      "omniroute_cloud_agent_send_message",
      { id: args.id },
      null,
      Date.now() - start,
      false,
      err instanceof Error ? err.message : String(err)
    );
    return errorResult(err);
  }
}

export async function handleCloudAgentApprovePlan(
  args: { id: string },
  extra?: McpToolExtraLike
): Promise<CloudAgentToolResult> {
  const start = Date.now();
  try {
    const path = `/api/v1/agents/tasks/${encodeURIComponent(args.id)}`;
    const raw = await callRestEndpoint(
      path,
      {
        method: "POST",
        body: JSON.stringify({ action: "approve" }),
      },
      resolveCallerToken(extra)
    );
    const payload = { ...toRecord(raw) };
    await logToolCall(
      "omniroute_cloud_agent_approve_plan",
      args,
      payload,
      Date.now() - start,
      true
    );
    return structuredResult(payload);
  } catch (err) {
    await logToolCall(
      "omniroute_cloud_agent_approve_plan",
      args,
      null,
      Date.now() - start,
      false,
      err instanceof Error ? err.message : String(err)
    );
    return errorResult(err);
  }
}
