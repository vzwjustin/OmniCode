import { MCP_TOOL_MAP } from "./schemas/tools.ts";

type AuthInfoLike = {
  clientId?: string;
  scopes?: string[];
  /**
   * The access token a transport's auth layer attaches when present.
   * Used by tools that need to forward the caller's credential to an
   * internal HTTP endpoint (e.g. the cloud-agent REST proxy). This is
   * server-attested and DIFFERENT from `_meta` — `_meta` is client-
   * controlled and ignored for both privileges and credentials.
   */
  token?: string;
};

export type McpToolExtraLike = {
  authInfo?: AuthInfoLike;
  sessionId?: string;
  _meta?: unknown;
};

/**
 * Canonical scope strings used by the MCP server. The runtime source of
 * truth for which scope is required by which tool is the `scopes: [...]`
 * array on each tool definition in `schemas/tools.ts` (read via
 * `MCP_TOOL_MAP[toolName].scopes`); these constants exist so handler
 * code, audit pipelines, and documentation can reference scope names
 * without re-typing the string literals.
 *
 * Adding a scope here does NOT grant it — a tool def must list it in
 * its `scopes` array to require it.
 */
export const MCP_SCOPES = {
  CLOUD_AGENT_READ: "cloud_agent:read",
  CLOUD_AGENT_WRITE: "cloud_agent:write",
} as const;

export type McpScope = (typeof MCP_SCOPES)[keyof typeof MCP_SCOPES];

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

/**
 * Detect whether the client tried to grant itself scopes via `_meta.scopes`,
 * `_meta.auth.scopes`, or `_meta.omniroute.scopes`. Any of these are CLIENT-
 * CONTROLLED inputs and MUST NEVER be honored — they were the privilege-
 * escalation vector documented in Tranche A — Task A4.
 *
 * Returns the offending paths so we can emit a single deprecation log per
 * tool call (INFO-level, with remediation guidance).
 */
function detectClientControlledMetaScopes(meta: unknown): string[] {
  if (!meta || typeof meta !== "object") return [];
  const metaRecord = meta as Record<string, unknown>;
  const offenders: string[] = [];

  if (normalizeScopeList(metaRecord.scopes).length > 0) {
    offenders.push("_meta.scopes");
  }

  const auth = metaRecord.auth;
  if (auth && typeof auth === "object") {
    if (normalizeScopeList((auth as Record<string, unknown>).scopes).length > 0) {
      offenders.push("_meta.auth.scopes");
    }
  }

  const omni = metaRecord.omniroute;
  if (omni && typeof omni === "object") {
    if (normalizeScopeList((omni as Record<string, unknown>).scopes).length > 0) {
      offenders.push("_meta.omniroute.scopes");
    }
  }

  return offenders;
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

export function resolveCallerScopeContext(
  extra: McpToolExtraLike | undefined,
  fallbackScopes: readonly string[] = []
): CallerScopeContext {
  const callerId =
    (typeof extra?.authInfo?.clientId === "string" && extra.authInfo.clientId.trim()) ||
    (typeof extra?.sessionId === "string" && extra.sessionId.trim()) ||
    "anonymous";

  // SECURITY (Tranche A — Task A4): `_meta` is CLIENT-CONTROLLED on every
  // MCP transport (stdio, SSE, streamable-http). Honoring `_meta.scopes`,
  // `_meta.auth.scopes`, or `_meta.omniroute.scopes` lets any caller
  // escalate to "*" by setting them in their tool call. We deliberately
  // ignore the entire `_meta` namespace for scope resolution. Only
  // server-attested `authInfo.scopes` (from the transport's auth layer)
  // or the env-configured fallback grant privileges.
  //
  // Clients that previously relied on `_meta.scopes` should configure
  // scopes via OAuth/authInfo or set OMNIROUTE_MCP_SCOPES on the server.
  const clientControlledMetaPaths = detectClientControlledMetaScopes(extra?._meta);
  if (clientControlledMetaPaths.length > 0) {
    console.info(
      `[MCP] Ignoring client-controlled scope grant in ${clientControlledMetaPaths.join(", ")} ` +
        `(caller=${callerId}). Configure scopes via authInfo or OMNIROUTE_MCP_SCOPES env.`
    );
  }

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
