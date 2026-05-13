import { getUnifiedModelsResponse } from "./catalog";

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, User-Agent, X-Requested-With, X-API-Key, X-OmniRoute-API-Key, X-Stainless-Retry-Count, anthropic-version, anthropic-beta, openai-organization, openai-project, openai-beta",
    },
  });
}

/**
 * GET /v1/models - OpenAI compatible models list
 */
export async function GET(request: Request) {
  return getUnifiedModelsResponse(request);
}
