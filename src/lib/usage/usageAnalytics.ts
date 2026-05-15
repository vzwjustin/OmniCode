/**
 * usage/usageAnalytics.ts — Aggregated read-only views over `usage_history`
 * (and a single JOIN through `provider_connections`) used by the analytics
 * dashboard.
 *
 * Routes and handlers MUST go through these helpers — never write raw SQL
 * against `usage_history` from outside this module or its sibling
 * `usageHistory.ts` (which owns CRUD + per-row read).
 */

import { getDbInstance } from "@/lib/db/core";

export interface UsageAnalyticsFilters {
  sinceIso?: string | null;
  untilIso?: string | null;
  apiKeyIds?: string[];
}

interface BuiltWhere {
  whereClause: string;
  apiKeyWhere: string;
  params: Record<string, string>;
}

/**
 * Build the shared WHERE clause + parameter map used by every analytics
 * query. `apiKeyWhere` is returned separately so callers (heatmap, fallback)
 * can compose it into custom WHERE expressions without re-parsing.
 */
function buildWhere(filters: UsageAnalyticsFilters): BuiltWhere {
  const conditions: string[] = [];
  const params: Record<string, string> = {};

  if (filters.sinceIso) {
    conditions.push("timestamp >= @since");
    params.since = filters.sinceIso;
  }
  if (filters.untilIso) {
    conditions.push("timestamp <= @until");
    params.until = filters.untilIso;
  }

  let apiKeyWhere = "";
  const apiKeyIds = filters.apiKeyIds ?? [];
  if (apiKeyIds.length > 0) {
    const placeholders = apiKeyIds.map((_, i) => `@apiKey${i}`);
    apiKeyIds.forEach((key, i) => {
      params[`apiKey${i}`] = key;
    });
    apiKeyWhere = `(api_key_name IN (${placeholders.join(",")}) OR api_key_id IN (${placeholders.join(",")}))`;
    conditions.push(apiKeyWhere);
  }

  return {
    whereClause: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    apiKeyWhere,
    params,
  };
}

function qualifyForUsageHistoryJoin(whereClause: string): string {
  return whereClause
    .replace(/timestamp/g, "usage_history.timestamp")
    .replace(/api_key_/g, "usage_history.api_key_");
}

export function getUsageSummary(filters: UsageAnalyticsFilters): Record<string, unknown> {
  const { whereClause, params } = buildWhere(filters);
  return getDbInstance()
    .prepare(
      `SELECT
         COUNT(*) as totalRequests,
         COALESCE(SUM(tokens_input), 0) as promptTokens,
         COALESCE(SUM(tokens_output), 0) as completionTokens,
         COALESCE(SUM(tokens_input + tokens_output), 0) as totalTokens,
         COUNT(DISTINCT model) as uniqueModels,
         COUNT(DISTINCT connection_id) as uniqueAccounts,
         COUNT(DISTINCT COALESCE(NULLIF(api_key_id, ''), NULLIF(api_key_name, ''))) as uniqueApiKeys,
         COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0) as successfulRequests,
         COALESCE(AVG(latency_ms), 0) as avgLatencyMs,
         COALESCE(MIN(timestamp), '') as firstRequest,
         COALESCE(MAX(timestamp), '') as lastRequest
       FROM usage_history
       ${whereClause}`
    )
    .get(params) as Record<string, unknown>;
}

export function getDailyUsage(filters: UsageAnalyticsFilters): Array<Record<string, unknown>> {
  const { whereClause, params } = buildWhere(filters);
  return getDbInstance()
    .prepare(
      `SELECT
         DATE(timestamp) as date,
         COUNT(*) as requests,
         COALESCE(SUM(tokens_input), 0) as promptTokens,
         COALESCE(SUM(tokens_output), 0) as completionTokens,
         COALESCE(SUM(tokens_input + tokens_output), 0) as totalTokens
       FROM usage_history
       ${whereClause}
       GROUP BY DATE(timestamp)
       ORDER BY date ASC`
    )
    .all(params) as Array<Record<string, unknown>>;
}

export function getDailyCostBreakdown(
  filters: UsageAnalyticsFilters
): Array<Record<string, unknown>> {
  const { whereClause, params } = buildWhere(filters);
  return getDbInstance()
    .prepare(
      `SELECT
         DATE(timestamp) as date,
         LOWER(provider) as provider,
         LOWER(model) as model,
         COALESCE(NULLIF(service_tier, ''), 'standard') as serviceTier,
         COALESCE(SUM(tokens_input), 0) as promptTokens,
         COALESCE(SUM(tokens_output), 0) as completionTokens,
         COALESCE(SUM(tokens_cache_read), 0) as cacheReadTokens,
         COALESCE(SUM(tokens_cache_creation), 0) as cacheCreationTokens,
         COALESCE(SUM(tokens_reasoning), 0) as reasoningTokens
       FROM usage_history
       ${whereClause}
       GROUP BY DATE(timestamp), LOWER(provider), LOWER(model), serviceTier
       ORDER BY date ASC`
    )
    .all(params) as Array<Record<string, unknown>>;
}

export function getHeatmapUsage(
  heatmapStartIso: string,
  filters: UsageAnalyticsFilters
): Array<Record<string, unknown>> {
  const { apiKeyWhere, params } = buildWhere(filters);
  const conditions = ["timestamp >= @heatmapStart"];
  if (apiKeyWhere) conditions.push(apiKeyWhere);
  const heatmapParams: Record<string, string> = { heatmapStart: heatmapStartIso };
  // Only api-key params from `params` are referenced in apiKeyWhere; the
  // since/until params are ignored by this query.
  for (const [key, value] of Object.entries(params)) {
    if (key.startsWith("apiKey")) heatmapParams[key] = value;
  }

  return getDbInstance()
    .prepare(
      `SELECT
         DATE(timestamp) as date,
         COALESCE(SUM(tokens_input + tokens_output), 0) as totalTokens
       FROM usage_history
       WHERE ${conditions.join(" AND ")}
       GROUP BY DATE(timestamp)
       ORDER BY date ASC`
    )
    .all(heatmapParams) as Array<Record<string, unknown>>;
}

export function getModelUsage(filters: UsageAnalyticsFilters): Array<Record<string, unknown>> {
  const { whereClause, params } = buildWhere(filters);
  return getDbInstance()
    .prepare(
      `SELECT
         LOWER(model) as model,
         LOWER(provider) as provider,
         COALESCE(NULLIF(service_tier, ''), 'standard') as serviceTier,
         COUNT(*) as requests,
         COALESCE(SUM(tokens_input), 0) as promptTokens,
         COALESCE(SUM(tokens_output), 0) as completionTokens,
         COALESCE(SUM(tokens_cache_read), 0) as cacheReadTokens,
         COALESCE(SUM(tokens_cache_creation), 0) as cacheCreationTokens,
         COALESCE(SUM(tokens_reasoning), 0) as reasoningTokens,
         COALESCE(SUM(tokens_input + tokens_output), 0) as totalTokens,
         COALESCE(AVG(latency_ms), 0) as avgLatencyMs,
         COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0) as successfulRequests,
         COALESCE(MAX(timestamp), '') as lastUsed
       FROM usage_history
       ${whereClause}
       GROUP BY LOWER(model), LOWER(provider), serviceTier
       ORDER BY requests DESC`
    )
    .all(params) as Array<Record<string, unknown>>;
}

export function getProviderCostBreakdown(
  filters: UsageAnalyticsFilters
): Array<Record<string, unknown>> {
  const { whereClause, params } = buildWhere(filters);
  return getDbInstance()
    .prepare(
      `SELECT
         LOWER(provider) as provider,
         LOWER(model) as model,
         COALESCE(NULLIF(service_tier, ''), 'standard') as serviceTier,
         COALESCE(SUM(tokens_input), 0) as promptTokens,
         COALESCE(SUM(tokens_output), 0) as completionTokens,
         COALESCE(SUM(tokens_cache_read), 0) as cacheReadTokens,
         COALESCE(SUM(tokens_cache_creation), 0) as cacheCreationTokens,
         COALESCE(SUM(tokens_reasoning), 0) as reasoningTokens
       FROM usage_history
       ${whereClause}
       GROUP BY LOWER(provider), LOWER(model), serviceTier`
    )
    .all(params) as Array<Record<string, unknown>>;
}

export function getProviderUsage(filters: UsageAnalyticsFilters): Array<Record<string, unknown>> {
  const { whereClause, params } = buildWhere(filters);
  return getDbInstance()
    .prepare(
      `SELECT
         LOWER(provider) as provider,
         COUNT(*) as requests,
         COALESCE(SUM(tokens_input), 0) as promptTokens,
         COALESCE(SUM(tokens_output), 0) as completionTokens,
         COALESCE(SUM(tokens_input + tokens_output), 0) as totalTokens,
         COALESCE(AVG(latency_ms), 0) as avgLatencyMs,
         COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0) as successfulRequests
       FROM usage_history
       ${whereClause}
       GROUP BY LOWER(provider)
       ORDER BY requests DESC`
    )
    .all(params) as Array<Record<string, unknown>>;
}

export function getAccountCostBreakdown(
  filters: UsageAnalyticsFilters
): Array<Record<string, unknown>> {
  const { whereClause, params } = buildWhere(filters);
  const qualifiedWhere = qualifyForUsageHistoryJoin(whereClause);
  return getDbInstance()
    .prepare(
      `SELECT
         COALESCE(NULLIF(c.display_name, ''), NULLIF(c.email, ''), NULLIF(c.name, ''), usage_history.connection_id, 'unknown') as account,
         LOWER(usage_history.provider) as provider,
         LOWER(usage_history.model) as model,
         COALESCE(NULLIF(usage_history.service_tier, ''), 'standard') as serviceTier,
         COALESCE(SUM(usage_history.tokens_input), 0) as promptTokens,
         COALESCE(SUM(usage_history.tokens_output), 0) as completionTokens,
         COALESCE(SUM(usage_history.tokens_cache_read), 0) as cacheReadTokens,
         COALESCE(SUM(usage_history.tokens_cache_creation), 0) as cacheCreationTokens,
         COALESCE(SUM(usage_history.tokens_reasoning), 0) as reasoningTokens
       FROM usage_history
       LEFT JOIN provider_connections c ON c.id = usage_history.connection_id
       ${qualifiedWhere}
       GROUP BY account, LOWER(usage_history.provider), LOWER(usage_history.model), serviceTier`
    )
    .all(params) as Array<Record<string, unknown>>;
}

export function getAccountUsage(filters: UsageAnalyticsFilters): Array<Record<string, unknown>> {
  const { whereClause, params } = buildWhere(filters);
  const qualifiedWhere = qualifyForUsageHistoryJoin(whereClause);
  return getDbInstance()
    .prepare(
      `SELECT
         COALESCE(NULLIF(c.display_name, ''), NULLIF(c.email, ''), NULLIF(c.name, ''), usage_history.connection_id, 'unknown') as account,
         COUNT(usage_history.id) as requests,
         COALESCE(SUM(usage_history.tokens_input), 0) as promptTokens,
         COALESCE(SUM(usage_history.tokens_output), 0) as completionTokens,
         COALESCE(SUM(usage_history.tokens_input + usage_history.tokens_output), 0) as totalTokens,
         COALESCE(AVG(usage_history.latency_ms), 0) as avgLatencyMs,
         COALESCE(MAX(usage_history.timestamp), '') as lastUsed
       FROM usage_history
       LEFT JOIN provider_connections c ON c.id = usage_history.connection_id
       ${qualifiedWhere}
       GROUP BY account
       ORDER BY requests DESC
       LIMIT 50`
    )
    .all(params) as Array<Record<string, unknown>>;
}

function buildApiKeyWhereClause(filters: UsageAnalyticsFilters): {
  sql: string;
  params: Record<string, string>;
} {
  const { whereClause, params } = buildWhere(filters);
  const condition =
    "(api_key_id IS NOT NULL AND api_key_id != '') OR (api_key_name IS NOT NULL AND api_key_name != '')";
  const sql = whereClause ? `${whereClause} AND (${condition})` : `WHERE (${condition})`;
  return { sql, params };
}

export function getApiKeyUsage(filters: UsageAnalyticsFilters): Array<Record<string, unknown>> {
  const { sql, params } = buildApiKeyWhereClause(filters);
  return getDbInstance()
    .prepare(
      `SELECT
         NULLIF(api_key_id, '') as apiKeyId,
         COALESCE(NULLIF(api_key_id, ''), NULLIF(api_key_name, ''), 'unknown') as apiKeyGroupKey,
         LOWER(provider) as provider,
         LOWER(model) as model,
         COALESCE(NULLIF(service_tier, ''), 'standard') as serviceTier,
         COUNT(*) as requests,
         COALESCE(SUM(tokens_input), 0) as promptTokens,
         COALESCE(SUM(tokens_output), 0) as completionTokens,
         COALESCE(SUM(tokens_cache_read), 0) as cacheReadTokens,
         COALESCE(SUM(tokens_cache_creation), 0) as cacheCreationTokens,
         COALESCE(SUM(tokens_reasoning), 0) as reasoningTokens,
         COALESCE(SUM(tokens_input + tokens_output), 0) as totalTokens
       FROM usage_history
       ${sql}
       GROUP BY COALESCE(NULLIF(api_key_id, ''), NULLIF(api_key_name, ''), 'unknown'), NULLIF(api_key_id, ''), LOWER(provider), LOWER(model), serviceTier`
    )
    .all(params) as Array<Record<string, unknown>>;
}

export function getServiceTierUsage(
  filters: UsageAnalyticsFilters
): Array<Record<string, unknown>> {
  const { whereClause, params } = buildWhere(filters);
  return getDbInstance()
    .prepare(
      `SELECT
         COALESCE(NULLIF(service_tier, ''), 'standard') as serviceTier,
         LOWER(provider) as provider,
         LOWER(model) as model,
         COUNT(*) as requests,
         COALESCE(SUM(tokens_input), 0) as promptTokens,
         COALESCE(SUM(tokens_output), 0) as completionTokens,
         COALESCE(SUM(tokens_cache_read), 0) as cacheReadTokens,
         COALESCE(SUM(tokens_cache_creation), 0) as cacheCreationTokens,
         COALESCE(SUM(tokens_reasoning), 0) as reasoningTokens,
         COALESCE(SUM(tokens_input + tokens_output), 0) as totalTokens
       FROM usage_history
       ${whereClause}
       GROUP BY serviceTier, LOWER(provider), LOWER(model)`
    )
    .all(params) as Array<Record<string, unknown>>;
}

export function getApiKeyMetadata(filters: UsageAnalyticsFilters): Array<Record<string, unknown>> {
  const { sql, params } = buildApiKeyWhereClause(filters);
  return getDbInstance()
    .prepare(
      `SELECT
         NULLIF(api_key_id, '') as apiKeyId,
         NULLIF(api_key_name, '') as apiKeyName,
         COALESCE(NULLIF(api_key_id, ''), NULLIF(api_key_name, ''), 'unknown') as apiKeyGroupKey,
         MAX(timestamp) as lastUsed
       FROM usage_history
       ${sql}
       GROUP BY NULLIF(api_key_id, ''), NULLIF(api_key_name, '')
       ORDER BY lastUsed DESC`
    )
    .all(params) as Array<Record<string, unknown>>;
}

export function getDayOfWeekUsage(filters: UsageAnalyticsFilters): Array<Record<string, unknown>> {
  const { whereClause, params } = buildWhere(filters);
  return getDbInstance()
    .prepare(
      `SELECT
         dayOfWeek,
         COUNT(*) as days,
         COALESCE(SUM(requests), 0) as requests,
         COALESCE(SUM(totalTokens), 0) as totalTokens
       FROM (
         SELECT
           DATE(timestamp) as date,
           strftime('%w', timestamp) as dayOfWeek,
           COUNT(*) as requests,
           COALESCE(SUM(tokens_input + tokens_output), 0) as totalTokens
         FROM usage_history
         ${whereClause}
         GROUP BY DATE(timestamp), strftime('%w', timestamp)
       )
       GROUP BY dayOfWeek
       ORDER BY dayOfWeek ASC`
    )
    .all(params) as Array<Record<string, unknown>>;
}

export interface PresetCostFilters {
  presetSinceIso: string | null;
  apiKeyIds?: string[];
}

export function getPresetModelCosts(filters: PresetCostFilters): Array<Record<string, unknown>> {
  const conditions: string[] = [];
  const params: Record<string, string> = {};

  if (filters.presetSinceIso) {
    conditions.push("timestamp >= @presetSince");
    params.presetSince = filters.presetSinceIso;
  }

  const apiKeyIds = filters.apiKeyIds ?? [];
  if (apiKeyIds.length > 0) {
    const placeholders = apiKeyIds.map((_, i) => `@apiKey${i}`);
    apiKeyIds.forEach((key, i) => {
      params[`apiKey${i}`] = key;
    });
    conditions.push(
      `(api_key_name IN (${placeholders.join(",")}) OR api_key_id IN (${placeholders.join(",")}))`
    );
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return getDbInstance()
    .prepare(
      `SELECT
         LOWER(model) as model,
         LOWER(provider) as provider,
         COALESCE(SUM(tokens_input), 0) as promptTokens,
         COALESCE(SUM(tokens_output), 0) as completionTokens,
         COALESCE(SUM(tokens_cache_read), 0) as cacheReadTokens,
         COALESCE(SUM(tokens_cache_creation), 0) as cacheCreationTokens,
         COALESCE(SUM(tokens_reasoning), 0) as reasoningTokens
       FROM usage_history
       ${where}
       GROUP BY LOWER(model), LOWER(provider)`
    )
    .all(params) as Array<Record<string, unknown>>;
}
