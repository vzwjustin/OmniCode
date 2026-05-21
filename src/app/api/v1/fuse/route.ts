/**
 * POST /v1/fuse — native local-fusion endpoint.
 *
 * Equivalent to calling /v1/chat/completions with model=local-fusion but
 * returns the full fusion result (candidates, critique, meta) for
 * debugging / dashboard use. Coding tools should keep using
 * /v1/chat/completions with model=local-fusion — that endpoint hides
 * fusion entirely and returns a normal OpenAI completion.
 */

import { CORS_HEADERS, handleCorsOptions } from "@/shared/utils/cors";
import { handleChat } from "@/sse/handlers/chat";
import { runFusion, parseFusionModelName } from "@omniroute/open-sse/handlers/fusion.ts";
import { initTranslators } from "@omniroute/open-sse/translator/index.ts";
import { z } from "zod";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

let initPromise: Promise<void> | null = null;
function ensureInitialized(): Promise<void> {
  if (!initPromise) {
    initPromise = Promise.resolve(initTranslators()).then(() => {
      // initialized
    });
  }
  return initPromise;
}

const fuseRequestSchema = z
  .object({
    messages: z
      .array(
        z.object({
          role: z.enum(["system", "user", "assistant", "tool"]),
          content: z.union([z.string(), z.array(z.unknown()), z.unknown()]),
          name: z.string().max(128).optional(),
        })
      )
      .min(1)
      .max(50),
    analysis_models: z.array(z.string().min(1).max(256)).max(16).optional(),
    judge_model: z.string().min(1).max(256).optional(),
    critic_model: z.string().min(1).max(256).optional(),
    mode: z.enum(["fast", "balanced", "deep", "code"]).optional(),
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().int().min(1).max(32_000).optional(),
    enable_critique: z.boolean().optional(),
    include_candidates: z.boolean().optional(),
  })
  .strict();

export async function OPTIONS() {
  return handleCorsOptions();
}

export async function POST(request: Request) {
  await ensureInitialized();

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return new Response(
      JSON.stringify({ error: { code: "VALIDATION_001", message: "Invalid JSON body" } }),
      { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }

  const validation = validateBody(fuseRequestSchema, rawBody);
  if (isValidationFailure(validation)) {
    return validation.response;
  }
  const body = validation.data;

  // For the native endpoint we always use the bare "local-fusion" alias —
  // the fusion handler will resolve mode + models from the body and the
  // saved config. We pass parsedModelName as null so explicit body fields
  // (or saved config) win cleanly.
  const planMode = body.mode;
  const fusionBody = {
    model: "local-fusion",
    messages: body.messages,
    temperature: body.temperature,
    max_tokens: body.max_tokens,
    analysis_models: body.analysis_models,
    judge_model: body.judge_model,
    critic_model: body.critic_model,
    fusion_mode: planMode,
    enable_critique: body.enable_critique,
    include_candidates: body.include_candidates,
    stream: false,
  };

  try {
    const result = await runFusion({
      body: fusionBody as any,
      parsedModelName: parseFusionModelName("local-fusion"),
      originalRequest: request,
      handleChat: (req) => handleChat(req),
    });

    const includeCandidates = body.include_candidates === true;
    const payload: Record<string, unknown> = {
      answer: result.answer,
      meta: {
        analysis_models: result.meta.analysisModels,
        judge_model: result.meta.judgeModel,
        critic_model: result.meta.criticModel,
        mode: result.meta.mode,
        cached: result.meta.cached,
        usage: result.meta.usage,
        latency_ms: result.meta.latencyMs,
        judge_failed: result.meta.judgeFailed,
        critic_failed: result.meta.criticFailed,
        fallback_reason: result.meta.fallbackReason,
      },
    };
    if (includeCandidates) {
      payload.candidates = result.candidates.map((c) => ({
        model: c.model,
        content: c.content,
        finish_reason: c.finishReason,
        usage: c.usage,
        latency_ms: c.latencyMs,
        error: c.error,
      }));
      payload.critique = result.critique;
    }

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    const e = err as { statusCode?: number; message?: string; detail?: unknown };
    const status = typeof e?.statusCode === "number" ? e.statusCode : 502;
    return new Response(
      JSON.stringify({
        error: {
          code: status === 400 ? "VALIDATION_001" : "FUSION_001",
          message: e?.message || "local-fusion run failed",
          ...(e?.detail ? { details: { upstream: e.detail } } : {}),
        },
      }),
      { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }
}
