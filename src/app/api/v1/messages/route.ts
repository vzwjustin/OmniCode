import { CORS_HEADERS } from "@/shared/utils/cors";
import { handleChat } from "@/sse/handlers/chat";
import { initTranslators } from "@omniroute/open-sse/translator/index.ts";
import { v1ChatCompletionsSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

let initialized = false;

/**
 * Initialize translators once
 */
async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
    console.log("[SSE] Translators initialized for /v1/messages");
  }
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
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * POST /v1/messages - Claude format (auto convert via handleChat)
 */
export async function POST(request) {
  await ensureInitialized();

  // Zod validation — accepts Anthropic shape (messages[] + top-level system)
  // as well as OpenAI/Responses shapes.
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
    console.error("[VALIDATION] /v1/messages body validation failed:", error);
  }

  return await handleChat(request);
}
