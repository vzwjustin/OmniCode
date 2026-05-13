import { MCP_TOOL_MAP } from "./schemas/tools.ts";

type AuthInfoLike = {
  clientId?: string;
  scopes?: string[];
};

export type McpToolExtraLike = {
  authInfo?: AuthInfoLike;
  sessionId?: string;
  _meta?: unknown;
};

export type ScopeSource = "authInfo" | "env" | "none";

export interface CallerScopeContext {
  callerId: string;
  scopes: string[];
  source: ScopeSource;
}

export interface ScopeCheckResult {
  allowed: boolean;
  required: string[];
  provided: string[];
  missing: string[];
  reason?: string;
}

function normalizeScopeList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const normalized = raw
    .filter((value) => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
  return Array.from(new Set(normalized));
}

function scopeMatches(grantedScope: string, requiredScope: string): boolean {
  if (grantedScope === "*" || grantedScope === requiredScope) {
    return true;
  }
  if (grantedScope.endsWith("*")) {
    const prefix = grantedScope.slice(0, -1);
    return requiredScope.startsWith(prefix);
  }
  return false;
}

/**
 * Resolve caller scopes.
 *
 * Only `authInfo.scopes` (derived from the validated bearer token / API key)
 * and the server-configured fallback env scopes are honored.
 *
 * Caller-supplied `_meta.scopes` is INTENTIONALLY IGNORED to prevent scope
 * escalation by malicious JSON-RPC callers.
 */
export function resolveCallerScopeContext(
  extra: McpToolExtraLike | undefined,
  fallbackScopes: readonly string[] = []
): CallerScopeContext {
  const callerId =
    (typeof extra?.authInfo?.clientId === "string" && extra.authInfo.clientId.trim()) ||
    (typeof extra?.sessionId === "string" && extra.sessionId.trim()) ||
    "anonymous";

  const authScopes = normalizeScopeList(extra?.authInfo?.scopes);
  if (authScopes.length > 0) {
    return { callerId, scopes: authScopes, source: "authInfo" };
  }

  const fallback = normalizeScopeList(fallbackScopes);
  if (fallback.length > 0) {
    return { callerId, scopes: fallback, source: "env" };
  }

  return { callerId, scopes: [], source: "none" };
}

export function evaluateToolScopes(
  toolName: string,
  callerScopes: readonly string[],
  enforceScopes: boolean
): ScopeCheckResult {
  const toolDef = MCP_TOOL_MAP[toolName];
  if (!toolDef) {
    return {
      allowed: false,
      required: [],
      provided: Array.from(callerScopes),
      missing: [],
      reason: "tool_definition_missing",
    };
  }

  const required = Array.isArray(toolDef.scopes) ? Array.from(toolDef.scopes) : [];
  const provided = normalizeScopeList(callerScopes);

  if (!enforceScopes || required.length === 0) {
    return { allowed: true, required, provided, missing: [] };
  }

  const missing = required.filter(
    (requiredScope) => !provided.some((grantedScope) => scopeMatches(grantedScope, requiredScope))
  );

  return {
    allowed: missing.length === 0,
    required,
    provided,
    missing,
    reason: missing.length > 0 ? "missing_scopes" : undefined,
  };
}
