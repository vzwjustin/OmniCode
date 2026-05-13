import { CORS_HEADERS, handleCorsOptions } from "@/shared/utils/cors";
import { handleChat } from "@/sse/handlers/chat";
import { initTranslators } from "@omniroute/open-sse/translator/index.ts";
import { v1ChatCompletionsSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

let initPromise = null;

/**
 * Initialize translators once (Promise-based singleton — no race condition)
 */
function ensureInitialized() {
  if (!initPromise) {
    initPromise = Promise.resolve(initTranslators()).then(() => {
      console.log("[SSE] Translators initialized");
    });
  }
  return initPromise;
}

function openAiValidationErrorResponse(
  message: string,
  param: string | null,
  status: number = 400
) {
  return new Response(
    JSON.stringify({
      error: {
        message,
        type: "invalid_request_error",
        param,
        code: "invalid_param",
      },
    }),
    { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
  );
}

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return handleCorsOptions();
}

export async function POST(request) {
  await ensureInitialized();

  // One-line marker for diagnosing 413 / Server-Action interceptions.
  // Logs only when Content-Length is present so debug noise stays low for
  // typical chat payloads. Toggle off via OMNIROUTE_LOG_REQUEST_SHAPE=0.
  if (process.env.OMNIROUTE_LOG_REQUEST_SHAPE !== "0") {
    const ct = request.headers.get("content-type") ?? "";
    const cl = request.headers.get("content-length");
    if (cl && Number(cl) > 256 * 1024) {
      console.error(`[CHAT-ROUTE] large body content-type="${ct}" content-length=${cl}`);
    }
  }

  // Zod validation of OpenAI chat-completions body shape (also accepts
  // Anthropic-shape `system` and Responses-API-shape `input`). We clone the
  // request so handleChat can still read the body downstream. Prompt
  // injection protection lives inside handleChat so all routes that delegate
  // there share the same guard.
  try {
    const cloned = request.clone();
    const body = await cloned.json().catch(() => null);
    if (body === null || typeof body !== "object") {
      return openAiValidationErrorResponse("Invalid JSON body", null);
    }
    const validation = validateBody(v1ChatCompletionsSchema, body);
    if (isValidationFailure(validation)) {
      const first = validation.error.details[0];
      const message = first
        ? `${first.field || "body"}: ${first.message}`
        : validation.error.message;
      return openAiValidationErrorResponse(message, first?.field || null);
    }
  } catch (error) {
    console.error("[VALIDATION] chat/completions body validation failed:", error);
  }

  return await handleChat(request);
}
