/**
 * A2A JSON-RPC 2.0 Router — `/a2a` endpoint
 *
 * Methods:
 *   - message/send     — Synchronous task execution
 *   - message/stream   — SSE streaming execution
 *   - tasks/get        — Query task by ID
 *   - tasks/cancel     — Cancel task by ID
 *
 * Auth: Bearer token via Authorization header, or management dashboard session cookie.
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getTaskManager } from "@/lib/a2a/taskManager";
import { logRoutingDecision } from "@/lib/a2a/routingLogger";
import { createA2AStream, SSE_HEADERS } from "@/lib/a2a/streaming";
import { A2A_SKILL_HANDLERS, executeA2ATaskWithState } from "@/lib/a2a/taskExecution";
import { getSettings } from "@/lib/db/settings";
import { isDashboardSessionAuthenticated, isLoopbackRequest } from "@/shared/utils/apiAuth";

// Custom application error code (JSON-RPC reserves -32000..-32099 for server-defined errors).
const A2A_ERROR_TASK_NOT_FOUND = -32010;

type A2AMessage = { role: string; content: string };

function toMessageArray(raw: unknown): A2AMessage[] | null {
  if (Array.isArray(raw)) {
    const normalized = raw
      .map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
        const msg = entry as Record<string, unknown>;
        const role = typeof msg.role === "string" && msg.role.trim() ? msg.role : "user";
        const content = typeof msg.content === "string" ? msg.content : null;
        if (!content) return null;
        return { role, content };
      })
      .filter((entry): entry is A2AMessage => !!entry);
    return normalized.length > 0 ? normalized : null;
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const message = raw as Record<string, unknown>;
  const role = typeof message.role === "string" && message.role.trim() ? message.role : "user";

  // Canonical A2A shape: { message: { role, content } }
  if (typeof message.content === "string" && message.content.trim()) {
    return [{ role, content: message.content }];
  }

  // Legacy compatibility: { message: { parts: [...] } }
  if (Array.isArray(message.parts)) {
    const text = message.parts
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object" || Array.isArray(part)) return "";
        const chunk = part as Record<string, unknown>;
        if (typeof chunk.content === "string") return chunk.content;
        if (typeof chunk.text === "string") return chunk.text;
        return "";
      })
      .filter((chunk) => chunk.trim().length > 0)
      .join("\n");
    if (text) return [{ role, content: text }];
  }

  return null;
}

// ============ Auth ============

/**
 * Constant-time string comparison to mitigate timing attacks on token comparison.
 */
function safeTokenEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Still consume time on a length-matched dummy to avoid leaking length differences.
    const dummy = Buffer.alloc(bufA.length);
    try {
      timingSafeEqual(bufA, dummy);
    } catch {
      /* noop */
    }
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

async function authenticate(req: NextRequest): Promise<boolean> {
  const configuredKey = process.env.OMNIROUTE_API_KEY;
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();

  // Bearer token wins if configured and matches.
  if (configuredKey && token && safeTokenEqual(token, configuredKey)) {
    return true;
  }

  // Management session cookie is also accepted.
  if (await isDashboardSessionAuthenticated(req)) {
    return true;
  }

  // No bearer key configured AND no session — only allow on loopback (local dev convenience).
  if (!configuredKey) {
    if (isLoopbackRequest(req)) {
      return true;
    }
    // Network-exposed request without configured key and without session → DENY.
    return false;
  }

  // Bearer key is configured but token didn't match (or was absent) → deny.
  return false;
}

// ============ JSON-RPC Helpers ============

function statusForCode(code: number): number {
  if (code === -32700) return 400;
  if (code === -32600) return 400;
  if (code === -32601) return 404;
  if (code === -32602) return 400;
  if (code === -32603) return 500;
  return 200;
}

function jsonRpcError(id: string | number | null, code: number, message: string, data?: unknown) {
  return NextResponse.json(
    { jsonrpc: "2.0", id, error: { code, message, data } },
    { status: statusForCode(code) }
  );
}

function jsonRpcResult(id: string | number | null, result: unknown) {
  return NextResponse.json({ jsonrpc: "2.0", id, result });
}

async function rejectIfA2ADisabled(id: string | number | null) {
  const settings = await getSettings();
  if (settings.a2aEnabled === true) return null;
  return NextResponse.json(
    {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: "A2A endpoint is disabled. Enable it from the Endpoints page.",
      },
    },
    { status: 503 }
  );
}

// ============ Route Handler ============

export async function POST(req: NextRequest) {
  console.log("==> HIT A2A ROUTER:", req.url);
  // Auth check (default-deny when no key configured and not on loopback)
  if (!(await authenticate(req))) {
    return jsonRpcError(null, -32600, "Unauthorized: missing or invalid credentials");
  }

  // Parse JSON-RPC body
  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonRpcError(null, -32700, "Parse error: invalid JSON");
  }

  // JSON-RPC batch requests are not supported.
  if (Array.isArray(body)) {
    return jsonRpcError(null, -32600, "Batch requests not supported");
  }

  if (!body || typeof body !== "object") {
    return jsonRpcError(null, -32600, "Invalid request: body must be a JSON object");
  }

  const { jsonrpc, id, method, params } = body as {
    jsonrpc?: unknown;
    id?: string | number | null;
    method?: unknown;
    params?: any;
  };

  // A request without an `id` field is a JSON-RPC notification — no response.
  const isNotification = !("id" in body) || id === undefined;

  if (jsonrpc !== "2.0" || typeof method !== "string" || !method) {
    if (isNotification) {
      return new Response(null, { status: 204 });
    }
    return jsonRpcError(
      (id ?? null) as string | number | null,
      -32600,
      "Invalid request: missing jsonrpc or method"
    );
  }

  // For notifications we still verify A2A is enabled but never send a body back.
  const disabledResponse = await rejectIfA2ADisabled((id ?? null) as string | number | null);
  if (disabledResponse) {
    if (isNotification) return new Response(null, { status: 204 });
    return disabledResponse;
  }

  const tm = getTaskManager();
  const respondId = (id ?? null) as string | number | null;

  // Helper that suppresses response bodies for notifications.
  const respond = (factory: () => Response | NextResponse): Response | NextResponse => {
    if (isNotification) return new Response(null, { status: 204 });
    return factory();
  };

  switch (method) {
    // ── message/send ──────────────────────────────────────
    case "message/send": {
      const skill = params?.skill || "smart-routing";
      const messages = toMessageArray(params?.messages) || toMessageArray(params?.message);
      if (!messages) {
        return respond(() =>
          jsonRpcError(
            respondId,
            -32602,
            "Invalid params: provide `messages[]` or `message.content`"
          )
        );
      }

      const handler = A2A_SKILL_HANDLERS[skill];
      if (!handler) {
        return respond(() => jsonRpcError(respondId, -32601, `Unknown skill: ${skill}`));
      }

      const task = tm.createTask({ skill, messages, metadata: params?.metadata });
      try {
        tm.updateTask(task.id, "working");
        const result = await handler(task);
        tm.updateTask(task.id, "completed", result.artifacts);

        // Log routing decision
        if (skill === "smart-routing" && result.metadata) {
          const smartMetadata = result.metadata as {
            routing_explanation?: string;
            cost_envelope?: { actual?: number };
          };
          logRoutingDecision({
            taskType: (params?.metadata?.role as string) || "general",
            comboId: (params?.metadata?.combo as string) || "default",
            providerSelected:
              smartMetadata.routing_explanation?.match(/"([^"]+)"/)?.[1] || "unknown",
            modelUsed: (params?.metadata?.model as string) || "auto",
            score: 1,
            factors: [],
            fallbacksTriggered: [],
            success: true,
            latencyMs: 0,
            cost: smartMetadata.cost_envelope?.actual || 0,
          });
        }

        return respond(() =>
          jsonRpcResult(respondId, {
            task: { id: task.id, state: "completed" },
            artifacts: result.artifacts,
            metadata: result.metadata,
          })
        );
      } catch (err) {
        console.error("A2A ERROR TRACE:", err);
        const msg = err instanceof Error ? err.message : String(err);
        tm.updateTask(task.id, "failed", [{ type: "error", content: msg }], msg);
        return respond(() => jsonRpcError(respondId, -32603, `Skill execution failed: ${msg}`));
      }
    }

    // ── message/stream ────────────────────────────────────
    case "message/stream": {
      const skill = params?.skill || "smart-routing";
      const messages = toMessageArray(params?.messages) || toMessageArray(params?.message);
      if (!messages) {
        return respond(() =>
          jsonRpcError(
            respondId,
            -32602,
            "Invalid params: provide `messages[]` or `message.content`"
          )
        );
      }

      const handler = A2A_SKILL_HANDLERS[skill];
      if (!handler) {
        return respond(() => jsonRpcError(respondId, -32601, `Unknown skill: ${skill}`));
      }

      // Streaming with a notification (no id) makes no sense — silently drop.
      if (isNotification) {
        return new Response(null, { status: 204 });
      }

      const task = tm.createTask({ skill, messages, metadata: params?.metadata });
      tm.updateTask(task.id, "working");

      const stream = createA2AStream(
        task,
        async (t) => executeA2ATaskWithState(tm, t, handler),
        req.signal,
        {
          onStart: () => tm.beginStream(),
          onEnd: () => tm.endStream(),
        }
      );

      return new Response(stream, { headers: SSE_HEADERS });
    }

    // ── tasks/get ─────────────────────────────────────────
    case "tasks/get": {
      const taskId = params?.taskId || params?.id;
      if (!taskId) {
        return respond(() => jsonRpcError(respondId, -32602, "Invalid params: taskId required"));
      }

      const task = tm.getTask(taskId);
      if (!task) {
        return respond(() =>
          jsonRpcError(respondId, A2A_ERROR_TASK_NOT_FOUND, `Task not found: ${taskId}`)
        );
      }

      return respond(() => jsonRpcResult(respondId, { task }));
    }

    // ── tasks/cancel ──────────────────────────────────────
    case "tasks/cancel": {
      const taskId = params?.taskId || params?.id;
      if (!taskId) {
        return respond(() => jsonRpcError(respondId, -32602, "Invalid params: taskId required"));
      }

      try {
        const task = tm.cancelTask(taskId);
        return respond(() =>
          jsonRpcResult(respondId, { task: { id: task.id, state: task.state } })
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Treat cancel-of-missing as the task-not-found application error.
        if (/not found/i.test(msg)) {
          return respond(() => jsonRpcError(respondId, A2A_ERROR_TASK_NOT_FOUND, msg));
        }
        return respond(() => jsonRpcError(respondId, -32603, msg));
      }
    }

    default:
      return respond(() => jsonRpcError(respondId, -32601, `Method not found: ${method}`));
  }
}

// Agent Card discovery via OPTIONS
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      Allow: "POST, OPTIONS",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}
