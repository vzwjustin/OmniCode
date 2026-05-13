import { isAuthRequired, isDashboardSessionAuthenticated } from "@/shared/utils/apiAuth";
import { createErrorResponse } from "@/lib/api/errorResponse";
import { extractApiKey, isValidApiKey } from "@/sse/services/auth";
import { getApiKeyMetadata } from "@/lib/db/apiKeys";

export const MANAGE_SCOPE = "manage";

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function hasManageScope(scopes: string[] = []): boolean {
  return scopes.includes("manage") || scopes.includes("admin");
}

function getMethod(request: Request): string {
  const method = (request as { method?: string }).method;
  return typeof method === "string" ? method.toUpperCase() : "GET";
}

function getHeader(request: Request, name: string): string | null {
  const headers = (request as { headers?: Headers }).headers;
  if (!headers || typeof headers.get !== "function") return null;
  return headers.get(name);
}

function getAllowedOrigins(): string[] {
  const raw = process.env.OMNIROUTE_DASHBOARD_ALLOWED_ORIGINS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function normalizeOrigin(value: string | null): string | null {
  if (!value) return null;
  try {
    const u = new URL(value);
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return null;
  }
}

function hostMatchesOrigin(host: string | null, originUrl: string): boolean {
  if (!host) return false;
  const origin = normalizeOrigin(originUrl);
  if (!origin) return false;
  // Compare host against the origin's authority (host[:port]). Allow either
  // http or https — the Secure-cookie / forwarded-proto checks elsewhere
  // already enforce TLS.
  try {
    const u = new URL(originUrl);
    return u.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * CSRF Origin check for session-cookie-authenticated, state-changing requests.
 *
 * Returns an error Response if the Origin header is present but does not match
 * the request's Host or an entry in `OMNIROUTE_DASHBOARD_ALLOWED_ORIGINS`.
 * Returns null when the request is allowed.
 */
function getRequestHost(request: Request): string | null {
  const headerHost = getHeader(request, "host");
  if (headerHost) return headerHost;
  // Fallback to the request URL (fetch strips `Host` from constructed Requests).
  const rawUrl = (request as { url?: string }).url;
  if (typeof rawUrl === "string" && rawUrl.length > 0) {
    try {
      return new URL(rawUrl).host;
    } catch {
      return null;
    }
  }
  return null;
}

function checkOriginForCsrf(request: Request): Response | null {
  const method = getMethod(request);
  if (!STATE_CHANGING_METHODS.has(method)) return null;

  const origin = getHeader(request, "origin");
  if (!origin) {
    // Absent Origin: rare in browsers. Allow — same-origin GETs and curl/SSR
    // calls land here. Bearer-token paths skip this check before reaching it.
    return null;
  }

  const host = getRequestHost(request);
  if (host && hostMatchesOrigin(host, origin)) return null;

  const allowed = getAllowedOrigins();
  const normalized = normalizeOrigin(origin);
  if (normalized && allowed.some((entry) => normalizeOrigin(entry) === normalized)) {
    return null;
  }

  return createErrorResponse({
    status: 403,
    message: "Cross-origin request rejected",
    type: "invalid_request",
  });
}

export async function requireManagementAuth(request: Request): Promise<Response | null> {
  if (!(await isAuthRequired(request))) {
    return null;
  }

  // For session-cookie authentication on state-changing methods, require an
  // Origin header that matches the request's Host (or a configured allowlist).
  // Bearer-token requests skip this check — the token itself is the auth.
  const hasBearer = Boolean(extractApiKey(request));
  if (!hasBearer) {
    const csrfRejection = checkOriginForCsrf(request);
    if (csrfRejection) return csrfRejection;
  }

  if (await isDashboardSessionAuthenticated(request)) {
    return null;
  }

  const apiKey = extractApiKey(request);
  if (apiKey) {
    let meta: Awaited<ReturnType<typeof getApiKeyMetadata>>;
    try {
      if (!(await isValidApiKey(apiKey))) {
        return createErrorResponse({
          status: 401,
          message: "Invalid API key",
          type: "invalid_request",
        });
      }
      meta = await getApiKeyMetadata(apiKey);
    } catch {
      return createErrorResponse({
        status: 503,
        message: "Service temporarily unavailable",
        type: "server_error",
      });
    }

    if (meta && hasManageScope(meta.scopes)) return null;

    return createErrorResponse({
      status: 403,
      message: "API key lacks 'manage' scope. Enable it in the API Manager dashboard.",
      type: "invalid_request",
    });
  }

  return createErrorResponse({
    status: 401,
    message: "Authentication required",
    type: "invalid_request",
  });
}
