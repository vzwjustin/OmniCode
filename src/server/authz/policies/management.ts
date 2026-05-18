import { isModelSyncInternalRequest } from "../../../shared/services/modelSyncScheduler";
import { isAuthRequired, isDashboardSessionAuthenticated } from "../../../shared/utils/apiAuth";
import type { AuthOutcome, PolicyContext, RoutePolicy } from "../context";
import { allow, reject } from "../context";

const MODEL_SYNC_MANAGEMENT_PATH = /^\/api\/providers\/[^/]+\/(sync-models|models)$/;

function hasBearerToken(headers: Headers): boolean {
  const authHeader = headers.get("authorization") ?? headers.get("Authorization");
  return typeof authHeader === "string" && authHeader.trim().toLowerCase().startsWith("bearer ");
}

function extractBearer(headers: Headers): string | null {
  const raw = headers.get("authorization") ?? headers.get("Authorization");
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) return null;
  return trimmed.slice(7).trim() || null;
}

function hasManageScope(scopes: readonly string[] | undefined): boolean {
  return Boolean(scopes?.includes("manage") || scopes?.includes("admin"));
}

function maskKeyId(apiKey: string): string {
  return `key_${apiKey.slice(-4)}`;
}

function isInternalModelSyncRequest(ctx: PolicyContext): boolean {
  if (!MODEL_SYNC_MANAGEMENT_PATH.test(ctx.classification.normalizedPath)) return false;
  return isModelSyncInternalRequest(ctx.request);
}

export const managementPolicy: RoutePolicy = {
  routeClass: "MANAGEMENT",
  async evaluate(ctx: PolicyContext): Promise<AuthOutcome> {
    if (!(await isAuthRequired(ctx.request))) {
      return allow({ kind: "anonymous", id: "anonymous", label: "auth-disabled" });
    }

    if (isInternalModelSyncRequest(ctx)) {
      return allow({ kind: "management_key", id: "model-sync", label: "internal-model-sync" });
    }

    if (await isDashboardSessionAuthenticated(ctx.request)) {
      return allow({ kind: "dashboard_session", id: "dashboard" });
    }

    const bearer = extractBearer(ctx.request.headers);
    if (bearer) {
      const { getApiKeyMetadata, validateApiKey } = await import("../../../lib/db/apiKeys");
      if (!(await validateApiKey(bearer))) {
        return reject(403, "AUTH_001", "Invalid management token");
      }

      const metadata = await getApiKeyMetadata(bearer);
      if (hasManageScope(metadata?.scopes)) {
        return allow({
          kind: "management_key",
          id: metadata?.id || maskKeyId(bearer),
          label: metadata?.name,
          scopes: metadata?.scopes || [],
        });
      }

      return reject(403, "AUTH_001", "API key lacks 'manage' scope");
    }

    const bearerPresent = hasBearerToken(ctx.request.headers);
    return reject(
      bearerPresent ? 403 : 401,
      "AUTH_001",
      bearerPresent ? "Invalid management token" : "Authentication required"
    );
  },
};
