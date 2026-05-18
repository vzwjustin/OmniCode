import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getProviderConnections } from "@/lib/db/providers";
import { resolveAllowedOrigin, STATIC_CORS_HEADERS } from "@/server/cors/origins";
import type { AgentCredentials } from "./baseAgent.ts";
import type { CloudAgentTaskRow } from "./db.ts";

type JsonRecord = Record<string, unknown>;

export function getCloudAgentCorsHeaders(request?: Request) {
  const headers: Record<string, string> = { ...STATIC_CORS_HEADERS };
  const origin = request?.headers.get("origin");
  const allowedOrigin = resolveAllowedOrigin(origin);
  if (allowedOrigin !== null) {
    headers["Access-Control-Allow-Origin"] = allowedOrigin;
    headers["Vary"] = "Origin";
    if (allowedOrigin !== "*") {
      headers["Access-Control-Allow-Credentials"] = "true";
    }
  }
  return headers;
}

export function withCloudAgentCors(response: Response, request?: Request): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(getCloudAgentCorsHeaders(request))) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function requireCloudAgentManagementAuth(request: Request): Promise<Response | null> {
  const authError = await requireManagementAuth(request);
  return authError ? withCloudAgentCors(authError, request) : null;
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function serializeCloudAgentTask(task: CloudAgentTaskRow) {
  return {
    id: task.id,
    providerId: task.provider_id,
    externalId: task.external_id,
    status: task.status,
    prompt: task.prompt,
    source: parseJson<JsonRecord>(task.source, {}),
    options: parseJson<JsonRecord>(task.options, {}),
    result: task.result ? parseJson<JsonRecord>(task.result, {}) : null,
    activities: parseJson<JsonRecord[]>(task.activities, []),
    error: task.error,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
    completedAt: task.completed_at,
  };
}

function getConnectionToken(connection: JsonRecord): string | null {
  const apiKey = typeof connection.apiKey === "string" ? connection.apiKey.trim() : "";
  if (apiKey) return apiKey;

  const accessToken =
    typeof connection.accessToken === "string" ? connection.accessToken.trim() : "";
  return accessToken || null;
}

export async function getCloudAgentCredentials(
  providerId: string
): Promise<AgentCredentials | null> {
  const connections = (await getProviderConnections({
    provider: providerId,
    isActive: true,
  })) as JsonRecord[];

  for (const connection of connections) {
    const token = getConnectionToken(connection);
    if (token) return { apiKey: token };
  }

  return null;
}
