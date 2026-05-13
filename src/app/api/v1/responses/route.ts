import { CORS_HEADERS } from "@/shared/utils/cors";
import { handleChat } from "@/sse/handlers/chat";
import { v1ChatCompletionsSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

// NOTE: We do NOT call initTranslators() here — the translator registry is
// bootstrapped at module level inside open-sse/translator/index.ts when it
// is first imported. Calling it again from a Next.js Route Handler caused a
// "the worker has exited" uncaughtException crash on Codex CLI requests (#450)
// because the dynamic import runs in a Next.js server worker context where
// certain Node APIs used by the translator bootstrap are not available.
// The translators are always initialized via the open-sse side (chatCore),
// so /v1/responses just delegates to handleChat which handles everything.

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

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * POST /v1/responses - OpenAI Responses API format
 * Handled by the unified chat handler (openai-responses format auto-detected).
 */
export async function POST(request) {
  // Zod validation — accepts messages[] OR input OR top-level Anthropic-shape.
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
    console.error("[VALIDATION] /v1/responses body validation failed:", error);
  }

  return await handleChat(request);
}
