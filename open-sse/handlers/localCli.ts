/**
 * Local CLI model adapter.
 *
 * Maps ``local:<slug>`` model ids to a configured local CLI binary
 * (Claude Code, Codex CLI, Gemini CLI, etc). The chat router invokes us
 * before falling through to OmniCode's provider/executor pipeline. The
 * prompt is fed via stdin — we NEVER use ``shell=true`` and NEVER
 * interpolate prompt content into argv, so caller input cannot escape
 * into shell metacharacters.
 *
 * Adapters are off by default. Admins enable a slug by setting its CMD
 * (and optional ARGS) in the fusion config (dashboard) or via env. Env
 * settings only seed the in-memory defaults; the persisted config wins.
 */

import { spawn } from "node:child_process";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import { getFusionConfig, type FusionConfigData } from "@/lib/db/fusionConfig";

export const LOCAL_CLI_PREFIX = "local:";

// Human-friendly id → internal config slug.
const LOCAL_CLI_ALIASES: Record<string, keyof FusionConfigData["localCli"]> = {
  "local:claude-code": "claudeCode",
  "local:claude": "claudeCode",
  "local:codex": "codex",
  "local:gemini": "gemini",
};

export function isLocalCliModelId(model: string | undefined | null): boolean {
  if (!model || typeof model !== "string") return false;
  return model.startsWith(LOCAL_CLI_PREFIX) && LOCAL_CLI_ALIASES[model.trim()] !== undefined;
}

export function listLocalCliModelNames(cfg?: FusionConfigData): string[] {
  const c = cfg ?? getFusionConfig();
  const out: string[] = [];
  for (const [alias, slug] of Object.entries(LOCAL_CLI_ALIASES)) {
    const adapter = c.localCli[slug];
    if (adapter && adapter.cmd && adapter.cmd.trim()) out.push(alias);
  }
  return Array.from(new Set(out)).sort();
}

interface ChatBody {
  model: string;
  messages?: Array<{ role: string; content: unknown; name?: string }>;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}

function coerceContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const p of content) {
      if (typeof p === "string") parts.push(p);
      else if (p && typeof p === "object") {
        const o = p as Record<string, unknown>;
        const t =
          typeof o.text === "string" ? o.text : typeof o.content === "string" ? o.content : "";
        if (t) parts.push(t);
      }
    }
    return parts.join("");
  }
  if (content == null) return "";
  return String(content);
}

function messagesToPrompt(messages: ChatBody["messages"]): string {
  const parts: string[] = [];
  for (const m of messages || []) {
    const text = coerceContent(m.content);
    if (!text) continue;
    const role = String(m.role || "user").toUpperCase();
    parts.push(`<<${role}>>\n${text}`);
  }
  return parts.join("\n\n").trim() + "\n";
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
  latencyMs: number;
}

async function runLocalCli(args: {
  cmd: string;
  argv: string[];
  prompt: string;
  timeoutMs: number;
  abortSignal: AbortSignal | null;
}): Promise<SpawnResult> {
  const { cmd, argv, prompt, timeoutMs, abortSignal } = args;
  const started = Date.now();

  return new Promise<SpawnResult>((resolve, reject) => {
    const child = spawn(cmd, argv, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    let timedOut = false;

    const finalize = (payload: SpawnResult | null, err: Error | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else if (payload) resolve(payload);
    };

    const cleanup = (): void => {
      try {
        if (timeoutTimer) clearTimeout(timeoutTimer);
      } catch {
        /* ignore */
      }
      if (abortSignal) {
        try {
          abortSignal.removeEventListener("abort", onAbort);
        } catch {
          /* ignore */
        }
      }
    };

    const onAbort = (): void => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      finalize(null, new Error("local-cli aborted by caller"));
    };
    if (abortSignal) {
      if (abortSignal.aborted) {
        onAbort();
        return;
      }
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    const timeoutTimer = setTimeout(
      () => {
        timedOut = true;
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        // Give the process 250 ms to die gracefully, then SIGKILL.
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }, 250);
      },
      Math.max(1000, timeoutMs)
    );

    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", (err) => {
      finalize(null, err);
    });
    child.on("close", (code) => {
      finalize(
        {
          stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
          stderr: Buffer.concat(stderrChunks).toString("utf-8"),
          code: code == null ? -1 : Number(code),
          timedOut,
          latencyMs: Date.now() - started,
        },
        null
      );
    });

    child.stdin?.end(prompt, "utf-8");
  });
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function buildOpenAIResponse(args: {
  body: ChatBody;
  content: string;
  latencyMs: number;
  stream: boolean;
}): Response {
  const { body, content, latencyMs, stream } = args;
  const id = `chatcmpl-local-cli-${Math.random().toString(36).slice(2, 12)}`;
  const created = Math.floor(Date.now() / 1000);
  const meta = { source: "local-cli", model: body.model, latency_ms: latencyMs };

  if (!stream) {
    return new Response(
      JSON.stringify({
        id,
        object: "chat.completion",
        created,
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        x_local_cli: meta,
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }

  const encoder = new TextEncoder();
  const sse = new ReadableStream<Uint8Array>({
    start(controller) {
      const first = {
        id,
        object: "chat.completion.chunk",
        created,
        model: body.model,
        choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
      };
      const final = {
        id,
        object: "chat.completion.chunk",
        created,
        model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        x_local_cli: meta,
      };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(first)}\n\n`));
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(final)}\n\n`));
      controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
      controller.close();
    },
  });
  return new Response(sse, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    },
  });
}

export async function handleLocalCliChat(args: {
  body: ChatBody;
  originalRequest: Request;
}): Promise<Response> {
  const { body, originalRequest } = args;

  const slug = LOCAL_CLI_ALIASES[body.model.trim()];
  if (!slug) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `Unknown local CLI model id '${body.model}'. Known: ${Object.keys(LOCAL_CLI_ALIASES).join(", ")}`
    );
  }

  const cfg = getFusionConfig();
  const adapter = cfg.localCli[slug];
  if (!adapter || !adapter.cmd || !adapter.cmd.trim()) {
    return errorResponse(
      HTTP_STATUS.SERVICE_UNAVAILABLE,
      `Local CLI '${body.model}' is not configured. Set its command path in Dashboard → Fusion → Local CLIs.`
    );
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "messages is required");
  }

  const prompt = messagesToPrompt(body.messages);
  const timeoutMs = cfg.localCli.timeoutMs || 240_000;

  let result: SpawnResult;
  try {
    result = await runLocalCli({
      cmd: adapter.cmd.trim(),
      argv: (adapter.args || []).map((a) => String(a)),
      prompt,
      timeoutMs,
      abortSignal: originalRequest.signal ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown subprocess spawn error";
    return errorResponse(
      HTTP_STATUS.BAD_GATEWAY,
      `Failed to launch local CLI '${body.model}': ${truncate(message, 200)}`
    );
  }

  if (result.timedOut) {
    return errorResponse(
      HTTP_STATUS.GATEWAY_TIMEOUT ?? 504,
      `Local CLI '${body.model}' timed out after ${timeoutMs}ms`
    );
  }
  if (result.code !== 0) {
    const tail = (result.stderr || result.stdout).trim().split("\n").slice(-3).join(" | ");
    return errorResponse(
      HTTP_STATUS.BAD_GATEWAY,
      `Local CLI '${body.model}' exited with code ${result.code}: ${truncate(tail || "no output", 180)}`
    );
  }

  const content = result.stdout.trim();
  if (!content) {
    return errorResponse(
      HTTP_STATUS.BAD_GATEWAY,
      `Local CLI '${body.model}' returned empty output.`
    );
  }

  return buildOpenAIResponse({
    body,
    content,
    latencyMs: result.latencyMs,
    stream: body.stream === true,
  });
}
