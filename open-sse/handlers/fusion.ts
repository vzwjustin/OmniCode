/**
 * Local-fusion handler.
 *
 * Intercepts requests whose model id starts with ``local-fusion`` (or one
 * of its mode variants / inline-config forms) and orchestrates a parallel
 * multi-model fusion server-side. The calling tool (Claude Code, Codex
 * CLI, an IDE, etc.) sends a normal OpenAI chat-completions request and
 * receives a normal OpenAI chat-completions response — it never sees the
 * fusion happen.
 *
 * Strategy: rather than reimplementing model dispatch, we fan out by
 * issuing internal sub-requests to ``handleChat()`` itself, one per
 * candidate model. This reuses the full OmniCode pipeline (auth, policy,
 * combos, executors, retries, providers, etc.) for every leg.
 */

import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import { getFusionConfig, type FusionConfigData } from "@/lib/db/fusionConfig";
import {
  buildAnalysisMessages,
  buildCriticMessages,
  buildJudgeMessages,
  type CandidateForPrompting,
} from "./fusionPrompts";

const FUSION_MODE_ALIASES: Record<string, FusionConfigData["mode"] | null> = {
  "local-fusion": null, // defer to active config
  "local-fusion-fast": "fast",
  "local-fusion-balanced": "balanced",
  "local-fusion-deep": "deep",
  "local-fusion-code": "code",
};

// "local-fusion-code:m1+m2+m3@judge"
const FUSION_INLINE_RE =
  /^(?<base>local-fusion(?:-(?:fast|balanced|deep|code))?)(?::(?<analysis>[^@]+))?(?:@(?<judge>.+))?$/;

const FUSION_MODEL_NAMES = Object.keys(FUSION_MODE_ALIASES);

export function isFusionModelId(modelStr: string | undefined | null): boolean {
  if (!modelStr || typeof modelStr !== "string") return false;
  return /^local-fusion(?:-(?:fast|balanced|deep|code))?(?::|@|$)/.test(modelStr.trim());
}

export function listFusionModelNames(): string[] {
  return [...FUSION_MODEL_NAMES];
}

interface ParsedFusionModelName {
  base: string;
  mode: FusionConfigData["mode"] | null;
  analysisModels: string[] | null;
  judgeModel: string | null;
}

function parseFusionModelName(modelStr: string): ParsedFusionModelName | null {
  const m = FUSION_INLINE_RE.exec(modelStr.trim());
  if (!m || !m.groups) return null;
  const base = m.groups.base;
  if (!(base in FUSION_MODE_ALIASES)) return null;
  const mode = FUSION_MODE_ALIASES[base];
  const analysisRaw = m.groups.analysis ?? null;
  const judgeRaw = m.groups.judge ?? null;
  const analysisModels =
    analysisRaw === null
      ? null
      : analysisRaw
          .split("+")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
  return {
    base,
    mode,
    analysisModels: analysisModels && analysisModels.length > 0 ? analysisModels : null,
    judgeModel: judgeRaw ? judgeRaw.trim() || null : null,
  };
}

interface ChatBody {
  model: string;
  messages?: Array<{ role: string; content: unknown; name?: string }>;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  // Custom fusion controls (also accepted on the OpenAI-compat surface):
  analysis_models?: string[];
  judge_model?: string;
  critic_model?: string;
  fusion_mode?: FusionConfigData["mode"];
  enable_critique?: boolean;
  include_candidates?: boolean;
  // Native /v1/fuse uses ``messages`` only.
}

interface ResolvedFusionPlan {
  mode: FusionConfigData["mode"];
  analysisModels: string[];
  judgeModel: string;
  criticModel: string | null;
  temperature: number;
  maxTokens: number;
  enableCritique: boolean;
  includeCandidates: boolean;
  cfg: FusionConfigData;
}

function resolvePlan(body: ChatBody, parsed: ParsedFusionModelName | null): ResolvedFusionPlan {
  const cfg = getFusionConfig();

  const mode: FusionConfigData["mode"] = body.fusion_mode || parsed?.mode || cfg.mode;

  const analysisModels =
    (Array.isArray(body.analysis_models) && body.analysis_models.length > 0
      ? body.analysis_models
      : null) ||
    parsed?.analysisModels ||
    cfg.analysisModels;

  const judgeModel =
    (typeof body.judge_model === "string" && body.judge_model.trim()) ||
    (parsed?.judgeModel ?? null) ||
    cfg.judgeModel;

  const criticModel =
    typeof body.critic_model === "string" && body.critic_model.trim()
      ? body.critic_model.trim()
      : cfg.criticModel;

  const temperature = typeof body.temperature === "number" ? body.temperature : cfg.temperature;
  const maxTokens =
    typeof body.max_tokens === "number" && body.max_tokens > 0 ? body.max_tokens : cfg.maxTokens;

  const enableCritique =
    typeof body.enable_critique === "boolean" ? body.enable_critique : cfg.enableCritique;

  const includeCandidates =
    typeof body.include_candidates === "boolean" ? body.include_candidates : false;

  if (!judgeModel) {
    throw Object.assign(new Error("local-fusion: no judge_model configured"), {
      statusCode: HTTP_STATUS.BAD_REQUEST,
    });
  }

  // Guard against self-recursion: a user could configure local-fusion as an
  // analysis target which would loop indefinitely. Reject up front.
  const allTargets = [...analysisModels, judgeModel, ...(criticModel ? [criticModel] : [])];
  for (const t of allTargets) {
    if (isFusionModelId(t)) {
      throw Object.assign(
        new Error(`local-fusion target '${t}' refers back to local-fusion (would loop)`),
        { statusCode: HTTP_STATUS.BAD_REQUEST }
      );
    }
  }

  if (analysisModels.length === 0) {
    throw Object.assign(new Error("local-fusion: no analysis_models configured"), {
      statusCode: HTTP_STATUS.BAD_REQUEST,
    });
  }

  return {
    mode,
    analysisModels: [...analysisModels],
    judgeModel,
    criticModel,
    temperature,
    maxTokens,
    enableCritique,
    includeCandidates,
    cfg,
  };
}

/**
 * Issue an internal OpenAI-style chat completion against this server's
 * own /v1/chat/completions pipeline (via ``handleChat``). Returns the
 * parsed JSON response or throws.
 */
async function callInternalChat(args: {
  handleChat: HandleChatFn;
  originalRequest: Request;
  model: string;
  messages: Array<{ role: string; content: unknown; name?: string }>;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  abortSignal: AbortSignal;
}): Promise<{
  content: string;
  finishReason: string | null;
  usage: Record<string, number> | null;
  latencyMs: number;
}> {
  const {
    handleChat,
    originalRequest,
    model,
    messages,
    temperature,
    maxTokens,
    timeoutMs,
    abortSignal,
  } = args;

  const subBody = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };

  const headers = new Headers();
  // Forward the auth context from the caller's request so the internal
  // sub-call passes the same policy + auth checks.
  const auth = originalRequest.headers.get("authorization");
  if (auth) headers.set("authorization", auth);
  const xKey = originalRequest.headers.get("x-api-key");
  if (xKey) headers.set("x-api-key", xKey);
  // Mark internal so any logging / metrics can filter these out if needed.
  headers.set("x-omniroute-internal", "local-fusion");
  headers.set("content-type", "application/json");
  // Force JSON response — never SSE for fusion legs.
  headers.set("accept", "application/json");

  const timer = AbortSignal.timeout(timeoutMs);
  const combined = anyAbortSignal([abortSignal, timer]);

  const url = new URL("/v1/chat/completions", new URL(originalRequest.url).origin);
  const subRequest = new Request(url.toString(), {
    method: "POST",
    headers,
    body: JSON.stringify(subBody),
    signal: combined,
  });

  const started = Date.now();
  const response = await handleChat(subRequest);
  const latencyMs = Date.now() - started;

  if (!response || typeof response.status !== "number") {
    throw new Error("internal chat handler returned invalid response");
  }
  if (response.status >= 400) {
    const text = await safeReadText(response);
    throw new Error(`upstream ${response.status}: ${truncate(text, 240)}`);
  }
  const ct = response.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    const text = await safeReadText(response);
    throw new Error(`upstream returned non-JSON content-type '${ct}': ${truncate(text, 200)}`);
  }
  let parsed: any;
  try {
    parsed = await response.json();
  } catch (err) {
    throw new Error(
      `upstream returned malformed JSON: ${err instanceof Error ? err.message : "parse error"}`
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("upstream response was not an object");
  }
  if (parsed.error) {
    const msg =
      typeof parsed.error === "string"
        ? parsed.error
        : parsed.error.message || "unknown upstream error";
    throw new Error(`upstream error: ${truncate(String(msg), 240)}`);
  }
  const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : null;
  const messageContent = choice?.message?.content;
  const content =
    typeof messageContent === "string"
      ? messageContent
      : Array.isArray(messageContent)
        ? coerceMultipart(messageContent)
        : "";
  const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : null;
  const usage = parsed.usage && typeof parsed.usage === "object" ? parsed.usage : null;
  return { content, finishReason, usage, latencyMs };
}

function coerceMultipart(parts: unknown[]): string {
  const out: string[] = [];
  for (const p of parts) {
    if (typeof p === "string") out.push(p);
    else if (p && typeof p === "object") {
      const o = p as Record<string, unknown>;
      const t =
        typeof o.text === "string" ? o.text : typeof o.content === "string" ? o.content : "";
      if (t) out.push(t);
    }
  }
  return out.join("");
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function anyAbortSignal(signals: Array<AbortSignal | undefined | null>): AbortSignal {
  const valid = signals.filter((s): s is AbortSignal => !!s);
  if (valid.length === 0) return new AbortController().signal;
  if (valid.length === 1) return valid[0];
  // AbortSignal.any is available in modern Node; fall back to manual.
  const anyFn = (AbortSignal as any).any as undefined | ((s: AbortSignal[]) => AbortSignal);
  if (typeof anyFn === "function") {
    return anyFn(valid);
  }
  const ctrl = new AbortController();
  for (const s of valid) {
    if (s.aborted) {
      ctrl.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}

interface CandidateResult extends CandidateForPrompting {
  finishReason: string | null;
  usage: Record<string, number> | null;
  latencyMs: number;
}

interface FusionMeta {
  mode: FusionConfigData["mode"];
  analysisModels: string[];
  judgeModel: string;
  criticModel: string | null;
  cached: boolean;
  usage: Record<string, number>;
  latencyMs: number;
  judgeFailed: boolean;
  criticFailed: boolean;
  fallbackReason: string | null;
}

export interface FusionRunResult {
  answer: string;
  candidates: CandidateResult[];
  critique: string | null;
  meta: FusionMeta;
}

// ---- module-level response cache for fusion answers ----
interface CachedAnswer {
  expiresAtMs: number;
  result: FusionRunResult;
}
const fusionCache = new Map<string, CachedAnswer>();
const FUSION_CACHE_MAX = 256;

function buildCacheKey(
  plan: ResolvedFusionPlan,
  messages: Array<{ role: string; content: unknown; name?: string }>
): string {
  const seed = JSON.stringify({
    mode: plan.mode,
    analysis: plan.analysisModels,
    judge: plan.judgeModel,
    critic: plan.criticModel,
    enableCritique: plan.enableCritique,
    temperature: Number(plan.temperature.toFixed(6)),
    maxTokens: plan.maxTokens,
    messages: messages.map((m) => ({ role: m.role, content: coerceContentForKey(m.content) })),
  });
  return cheapHash(seed);
}

function coerceContentForKey(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return coerceMultipart(c);
  return JSON.stringify(c ?? "");
}

function cheapHash(s: string): string {
  // FNV-1a 32-bit — fast, dependency-free, good enough for in-memory cache keys.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}

function cacheGet(key: string): FusionRunResult | null {
  const now = Date.now();
  const entry = fusionCache.get(key);
  if (!entry) return null;
  if (entry.expiresAtMs < now) {
    fusionCache.delete(key);
    return null;
  }
  return entry.result;
}

function cacheSet(key: string, result: FusionRunResult, ttlSeconds: number): void {
  if (ttlSeconds <= 0) return;
  if (fusionCache.size >= FUSION_CACHE_MAX) {
    const oldest = fusionCache.keys().next().value as string | undefined;
    if (oldest) fusionCache.delete(oldest);
  }
  fusionCache.set(key, {
    expiresAtMs: Date.now() + ttlSeconds * 1000,
    result,
  });
}

export function clearFusionCache(): void {
  fusionCache.clear();
}

type HandleChatFn = (request: Request) => Promise<Response>;

/**
 * Core orchestration. Takes a parsed OpenAI-style body and runs the
 * analysis/critic/judge pipeline. Caller is responsible for wrapping the
 * returned ``answer`` into the response shape they need (chat completion,
 * native fuse, SSE, etc.).
 */
export async function runFusion(args: {
  body: ChatBody;
  parsedModelName: ParsedFusionModelName | null;
  originalRequest: Request;
  handleChat: HandleChatFn;
}): Promise<FusionRunResult> {
  const { body, parsedModelName, originalRequest, handleChat } = args;
  const plan = resolvePlan(body, parsedModelName);
  const startedAt = Date.now();

  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) {
    throw Object.assign(new Error("local-fusion: messages is required"), {
      statusCode: HTTP_STATUS.BAD_REQUEST,
    });
  }

  // Cache lookup.
  const cacheKey = buildCacheKey(plan, messages);
  if (plan.cfg.enableCache) {
    const cached = cacheGet(cacheKey);
    if (cached) {
      return {
        ...cached,
        meta: { ...cached.meta, cached: true, latencyMs: Date.now() - startedAt },
      };
    }
  }

  // Analysis fan-out, in parallel.
  const analysisPromptMessages = buildAnalysisMessages(messages as any);

  const timeoutMs = plan.cfg.perModelTimeoutMs;
  const candidates: CandidateResult[] = await Promise.all(
    plan.analysisModels.map(async (modelId): Promise<CandidateResult> => {
      try {
        const r = await callInternalChat({
          handleChat,
          originalRequest,
          model: modelId,
          messages: analysisPromptMessages,
          temperature: plan.temperature,
          maxTokens: plan.maxTokens,
          timeoutMs,
          abortSignal: originalRequest.signal,
        });
        return {
          model: modelId,
          content: r.content,
          error: null,
          finishReason: r.finishReason,
          usage: r.usage,
          latencyMs: r.latencyMs,
        };
      } catch (err) {
        return {
          model: modelId,
          content: null,
          error: err instanceof Error ? truncate(err.message, 240) : "unknown error",
          finishReason: null,
          usage: null,
          latencyMs: 0,
        };
      }
    })
  );

  const successful = candidates.filter(
    (c) => c.error === null && (c.content || "").trim().length > 0
  );
  if (successful.length === 0) {
    const detail = candidates.map((c) => `${c.model}: ${c.error || "empty content"}`);
    throw Object.assign(new Error("local-fusion: all analysis models failed"), {
      statusCode: HTTP_STATUS.BAD_GATEWAY,
      detail,
    });
  }

  // Optional critic pass.
  let critique: string | null = null;
  let criticFailed = false;
  const criticEligibleModes = new Set(["balanced", "deep", "code"]);
  if (
    plan.enableCritique &&
    plan.criticModel &&
    criticEligibleModes.has(plan.mode) &&
    successful.length > 1
  ) {
    try {
      const criticMessages = buildCriticMessages(messages as any, successful);
      const r = await callInternalChat({
        handleChat,
        originalRequest,
        model: plan.criticModel,
        messages: criticMessages,
        temperature: Math.min(0.4, plan.temperature),
        maxTokens: Math.min(2000, plan.maxTokens),
        timeoutMs,
        abortSignal: originalRequest.signal,
      });
      const trimmed = (r.content || "").trim();
      critique = trimmed.length > 0 ? trimmed : null;
    } catch {
      criticFailed = true;
      critique = null;
    }
  }

  // Judge synthesis.
  let answer = "";
  let judgeFailed = false;
  let judgeUsage: Record<string, number> | null = null;
  let fallbackReason: string | null = null;
  try {
    const judgeMessages = buildJudgeMessages(messages as any, successful, critique, plan.mode);
    const r = await callInternalChat({
      handleChat,
      originalRequest,
      model: plan.judgeModel,
      messages: judgeMessages,
      temperature: plan.temperature,
      maxTokens: plan.maxTokens,
      timeoutMs,
      abortSignal: originalRequest.signal,
    });
    answer = (r.content || "").trim();
    if (!answer) {
      throw new Error("judge returned empty content");
    }
    judgeUsage = r.usage;
  } catch {
    // Fallback: longest non-empty candidate.
    const best = successful
      .slice()
      .sort((a, b) => (b.content?.length || 0) - (a.content?.length || 0))[0];
    if (!best || !best.content) {
      throw Object.assign(
        new Error("local-fusion: judge failed and no candidate fallback available"),
        {
          statusCode: HTTP_STATUS.BAD_GATEWAY,
        }
      );
    }
    answer = best.content;
    judgeFailed = true;
    fallbackReason = `judge_fallback_to:${best.model}`;
  }

  // Aggregate usage.
  const totalUsage: Record<string, number> = {};
  let haveAnyUsage = false;
  const acc = (u: Record<string, number> | null) => {
    if (!u) return;
    haveAnyUsage = true;
    for (const k of ["prompt_tokens", "completion_tokens", "total_tokens"] as const) {
      const v = Number(u[k] || 0);
      if (Number.isFinite(v) && v > 0) {
        totalUsage[k] = (totalUsage[k] || 0) + v;
      }
    }
  };
  for (const c of candidates) acc(c.usage);
  acc(judgeUsage);
  if (
    haveAnyUsage &&
    (totalUsage.total_tokens || 0) === 0 &&
    ((totalUsage.prompt_tokens || 0) > 0 || (totalUsage.completion_tokens || 0) > 0)
  ) {
    totalUsage.total_tokens = (totalUsage.prompt_tokens || 0) + (totalUsage.completion_tokens || 0);
  }

  const result: FusionRunResult = {
    answer,
    candidates,
    critique,
    meta: {
      mode: plan.mode,
      analysisModels: plan.analysisModels,
      judgeModel: plan.judgeModel,
      criticModel: plan.criticModel,
      cached: false,
      usage: haveAnyUsage ? totalUsage : {},
      latencyMs: Date.now() - startedAt,
      judgeFailed,
      criticFailed,
      fallbackReason,
    },
  };

  if (plan.cfg.enableCache) {
    cacheSet(cacheKey, result, plan.cfg.cacheTtlSeconds);
  }

  return result;
}

/**
 * Entry point invoked by the chat router when ``body.model`` looks like a
 * local-fusion alias. Returns an OpenAI-shape Response so the caller's
 * chat client sees a normal chat completion.
 */
export async function handleFusionChat(args: {
  body: ChatBody;
  originalRequest: Request;
  handleChat: HandleChatFn;
}): Promise<Response> {
  const { body, originalRequest, handleChat } = args;

  const parsed = parseFusionModelName(body.model);
  if (!parsed) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `Unknown local-fusion model id '${body.model}'. Use one of: ${listFusionModelNames().join(", ")}`
    );
  }

  // The active-config flag turns the whole feature off if the user wants.
  const cfg = getFusionConfig();
  if (!cfg.enabled) {
    return errorResponse(
      HTTP_STATUS.SERVICE_UNAVAILABLE,
      "local-fusion is disabled in the dashboard. Re-enable it under Dashboard → Fusion."
    );
  }

  let result: FusionRunResult;
  try {
    result = await runFusion({ body, parsedModelName: parsed, originalRequest, handleChat });
  } catch (err) {
    const e = err as any;
    const status = typeof e?.statusCode === "number" ? e.statusCode : HTTP_STATUS.BAD_GATEWAY;
    const message =
      typeof e?.message === "string" ? e.message : "local-fusion orchestration failed";
    return errorResponse(status, message);
  }

  return buildOpenAIResponse({
    body,
    result,
    stream: body.stream === true,
  });
}

function buildOpenAIResponse(args: {
  body: ChatBody;
  result: FusionRunResult;
  stream: boolean;
}): Response {
  const { body, result, stream } = args;
  const id = `chatcmpl-local-fusion-${Math.random().toString(36).slice(2, 12)}`;
  const created = Math.floor(Date.now() / 1000);

  const meta = {
    mode: result.meta.mode,
    analysis_models: result.meta.analysisModels,
    judge_model: result.meta.judgeModel,
    critic_model: result.meta.criticModel,
    cached: result.meta.cached,
    latency_ms: result.meta.latencyMs,
    judge_failed: result.meta.judgeFailed,
    critic_failed: result.meta.criticFailed,
    fallback_reason: result.meta.fallbackReason,
  };

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
            message: { role: "assistant", content: result.answer },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: result.meta.usage.prompt_tokens || 0,
          completion_tokens: result.meta.usage.completion_tokens || 0,
          total_tokens: result.meta.usage.total_tokens || 0,
        },
        x_local_fusion: meta,
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
  }

  // Stream: emit a single fused content chunk followed by [DONE]. This
  // matches how OpenAI clients render streamed responses without needing
  // upstream-style token-by-token streaming.
  const encoder = new TextEncoder();
  const stream2 = new ReadableStream<Uint8Array>({
    start(controller) {
      const first = {
        id,
        object: "chat.completion.chunk",
        created,
        model: body.model,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: result.answer },
            finish_reason: null,
          },
        ],
      };
      const final = {
        id,
        object: "chat.completion.chunk",
        created,
        model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        x_local_fusion: meta,
      };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(first)}\n\n`));
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(final)}\n\n`));
      controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
      controller.close();
    },
  });

  return new Response(stream2, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    },
  });
}

export { parseFusionModelName };
export type { ParsedFusionModelName };
