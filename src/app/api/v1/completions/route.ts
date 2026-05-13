import { CORS_HEADERS } from "@/shared/utils/cors";
import { buildClientRawRequest, handleChat } from "@/sse/handlers/chat";
import { initTranslators } from "@omniroute/open-sse/translator/index.ts";
import { v1ChatCompletionsSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

let initPromise = null;

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
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * POST /v1/completions — Legacy OpenAI Completions API
 *
 * Accepts both the modern chat format (messages[]) and the legacy
 * text-completions format (prompt string). Legacy requests are
 * automatically normalized to chat/completions format before routing.
 *
 * @see https://platform.openai.com/docs/api-reference/completions
 */
export async function POST(request: Request) {
  await ensureInitialized();

  // Body parsing + validation. We need the parsed body anyway to perform the
  // legacy prompt→messages normalization, so do both here. Prompt injection
  // protection is performed inside handleChat for every shared entry point.
  let body: any = null;
  try {
    const cloned = request.clone();
    body = await cloned.json().catch(() => null);
  } catch {
    body = null;
  }
  if (body === null || typeof body !== "object") {
    return openAiValidationErrorResponse("Invalid JSON body", null);
  }
  const validation = validateBody(v1ChatCompletionsSchema, body);
  if (isValidationFailure(validation)) {
    const first = validation.error.details[0];
    const message = first ? `${first.field || "body"}: ${first.message}` : validation.error.message;
    return openAiValidationErrorResponse(message, first?.field || null);
  }

  // Normalize legacy completions format: { prompt, model } → { messages, model }
  // If the body has `prompt` but no `messages`, convert to chat format.
  if (body.prompt !== undefined && !body.messages) {
    const prompt = Array.isArray(body.prompt) ? body.prompt.join("\n") : String(body.prompt);
    const normalized = {
      ...body,
      messages: [{ role: "user", content: prompt }],
    };
    delete normalized.prompt;

    const newRequest = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: JSON.stringify(normalized),
    });
    return await handleChat(newRequest, buildClientRawRequest(request, body));
  }

  // Standard path: body already has messages[] (chat format)
  return await handleChat(request);
}
