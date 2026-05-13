// Allow large audio/video file uploads — 5min for processing large files (up to 2GB)
export const maxDuration = 300;
import { handleAudioTranscription } from "@omniroute/open-sse/handlers/audioTranscription.ts";
import { getProviderCredentials, clearRecoveredProviderState } from "@/sse/services/auth";
import {
  parseTranscriptionModel,
  getTranscriptionProvider,
  buildDynamicAudioProvider,
  type ProviderNodeRow,
} from "@omniroute/open-sse/config/audioRegistry.ts";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import { getProviderNodes } from "@/lib/localDb";
import { v1AudioTranscriptionsSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, User-Agent, X-Requested-With, X-API-Key, X-OmniRoute-API-Key, X-Stainless-Retry-Count, anthropic-version, anthropic-beta, openai-organization, openai-project, openai-beta",
    },
  });
}

/**
 * POST /v1/audio/transcriptions — transcribe audio files
 * OpenAI Whisper API compatible (multipart/form-data)
 */
export async function POST(request) {
  let formData;
  try {
    formData = await request.formData();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid multipart form data");
  }

  // Build a plain object snapshot of the multipart form for Zod validation.
  // FormData entries can include uploaded File/Blob values, so we keep them
  // as-is and let the schema check for the Blob-like shape on `file`.
  const formObject: Record<string, unknown> = {};
  for (const [key, value] of (formData as FormData).entries()) {
    formObject[key] = value;
  }

  const validation = validateBody(v1AudioTranscriptionsSchema, formObject);
  if (isValidationFailure(validation)) {
    const first = validation.error.details[0];
    const message = first ? `${first.field || "body"}: ${first.message}` : validation.error.message;
    return errorResponse(HTTP_STATUS.BAD_REQUEST, message);
  }
  const model = validation.data.model;

  // Enforce API key policies (model restrictions + budget limits)
  const policy = await enforceApiKeyPolicy(request, model as string);
  if (policy.rejection) return policy.rejection;

  // Load local provider_nodes for audio routing (only localhost — prevents auth bypass/SSRF)
  let dynamicProviders: ReturnType<typeof buildDynamicAudioProvider>[] = [];
  try {
    const nodes = await getProviderNodes();
    dynamicProviders = (Array.isArray(nodes) ? (nodes as unknown as ProviderNodeRow[]) : [])
      .filter((n: ProviderNodeRow) => {
        if (n.apiType !== "chat" && n.apiType !== "responses") return false;
        try {
          const hostname = new URL(n.baseUrl).hostname;
          // Strictly matching 172.16.0.0/12 (Docker/local) and explicitly blocking ::1 per SSRF hardening
          return (
            hostname === "localhost" ||
            hostname === "127.0.0.1" ||
            /^172\.(1[6-9]|2[0-9]|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(hostname)
          );
        } catch {
          return false;
        }
      })
      .map((n) => buildDynamicAudioProvider(n, "/audio/transcriptions"));
  } catch {
    // DB error — fall back to hardcoded providers only
  }

  const { provider, model: resolvedModel } = parseTranscriptionModel(
    model as string,
    dynamicProviders
  );
  if (!provider) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `Invalid transcription model: ${model}. Use format: provider/model`
    );
  }

  // Check provider config — hardcoded first, then dynamic
  const providerConfig =
    getTranscriptionProvider(provider) || dynamicProviders.find((dp) => dp.id === provider) || null;

  // Get credentials — skip for local providers (authType: "none")
  let credentials = null;
  if (providerConfig && providerConfig.authType !== "none") {
    credentials = await getProviderCredentials(provider);
    if (!credentials) {
      return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`);
    }
  }

  const response = await handleAudioTranscription({
    formData,
    credentials,
    resolvedProvider: providerConfig,
    resolvedModel,
  });
  if (response?.ok) {
    await clearRecoveredProviderState(credentials);
  }
  return response;
}
