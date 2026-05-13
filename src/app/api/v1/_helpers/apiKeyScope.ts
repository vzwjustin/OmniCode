import { NextResponse } from "next/server";
import { getApiKeyMetadata } from "@/lib/localDb";
import { extractApiKey } from "@/sse/services/auth";
import {
  isAuthRequired,
  isDashboardSessionAuthenticated,
  isLoopbackRequest,
} from "@/shared/utils/apiAuth";

export interface ApiKeyRequestScope {
  apiKey: string | null;
  apiKeyId: string | null;
  apiKeyMetadata: Awaited<ReturnType<typeof getApiKeyMetadata>>;
  rejection: Response | null;
  isSessionAuth: boolean;
}

/**
 * Build the API-key request scope for `/api/v1/*` routes.
 *
 * Security: when `REQUIRE_API_KEY=true` is set in the environment and the
 * incoming request carries neither a Bearer API key, nor an authenticated
 * dashboard session, nor a loopback bootstrap origin, this helper short-circuits
 * with a 401 OpenAI-shape error so downstream handlers never see anonymous
 * traffic. Loopback bootstrap and session-authenticated callers continue to
 * pass through unchanged for backwards compatibility.
 */
export async function getApiKeyRequestScope(request: Request): Promise<ApiKeyRequestScope> {
  const isSessionAuth = await isDashboardSessionAuthenticated(request);
  const apiKey = extractApiKey(request);

  if (!apiKey) {
    const requireApiKey = process.env.REQUIRE_API_KEY === "true";
    // Honor existing settings-driven auth gate too (e.g. requireLogin === false
    // disables auth wholesale, fresh-install bootstrap on loopback, etc.).
    const authStillRequired = await isAuthRequired(request);

    if (requireApiKey && authStillRequired && !isSessionAuth && !isLoopbackRequest(request)) {
      const rejection = NextResponse.json(
        {
          error: {
            message: "Authentication required",
            type: "invalid_request_error",
            code: "missing_api_key",
          },
        },
        { status: 401 }
      );
      return {
        apiKey: null,
        apiKeyId: null,
        apiKeyMetadata: null,
        rejection,
        isSessionAuth,
      };
    }

    return { apiKey: null, apiKeyId: null, apiKeyMetadata: null, rejection: null, isSessionAuth };
  }

  const apiKeyMetadata = await getApiKeyMetadata(apiKey);
  return {
    apiKey,
    apiKeyId: apiKeyMetadata?.id || null,
    apiKeyMetadata,
    rejection: null,
    isSessionAuth,
  };
}
