import { handleChat } from "@/sse/handlers/chat";
import { handleCorsOptions } from "@/shared/utils/cors";

// NOTE: We do NOT call initTranslators() here — the translator registry is
// bootstrapped at module level inside open-sse/translator/index.ts when it
// is first imported. Calling it again from a Next.js Route Handler caused a
// "the worker has exited" uncaughtException crash on Codex CLI requests (#450)
// because the dynamic import runs in a Next.js server worker context where
// certain Node APIs used by the translator bootstrap are not available.
// The translators are always initialized via the open-sse side (chatCore),
// so /v1/responses just delegates to handleChat which handles everything.

/**
 * Tranche B — B6 (Bug review item #8)
 *
 * Previously this route shipped a hand-rolled OPTIONS that only included
 * `Access-Control-Allow-Methods` and `Access-Control-Allow-Headers: *`. It
 * was missing the central CORS_HEADERS contract (full method list, explicit
 * x-api-key / anthropic-version / x-omniroute-connection allowed headers)
 * and bypassed the middleware's per-origin overlay. Delegate to the shared
 * handler so /v1/responses gets the same preflight as /v1/chat/completions.
 */
export async function OPTIONS() {
  return handleCorsOptions();
}

/**
 * POST /v1/responses - OpenAI Responses API format
 * Handled by the unified chat handler (openai-responses format auto-detected).
 */
export async function POST(request) {
  return await handleChat(request);
}
