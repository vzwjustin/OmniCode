/**
 * usage/callLogAggregates.ts — Aggregated read-only views over the
 * `call_logs` table for analytics dashboards.
 *
 * Routes and handlers MUST go through these helpers — never write raw SQL
 * against `call_logs` from outside this module or its sibling
 * `callLogs.ts` (which owns CRUD).
 */

import { getDbInstance } from "@/lib/db/core";

export interface ProviderMetricsRow {
  provider: string;
  totalRequests: number;
  totalSuccesses: number;
  avgLatencyMs: number;
}

export function getProviderMetrics(): ProviderMetricsRow[] {
  return getDbInstance()
    .prepare(
      `SELECT
         provider,
         COUNT(*) as totalRequests,
         SUM(CASE WHEN status >= 200 AND status < 400 THEN 1 ELSE 0 END) as totalSuccesses,
         ROUND(AVG(duration)) as avgLatencyMs
       FROM call_logs
       WHERE provider IS NOT NULL AND provider != '-'
       GROUP BY provider`
    )
    .all() as ProviderMetricsRow[];
}

export interface SearchAnalyticsAggregate {
  total: number;
  today: number;
  errors: number;
  avgDurationMs: number;
  cached: number;
  byProvider: Array<{ provider: string; count: number }>;
}

export function getSearchAnalytics(todayStartIso: string): SearchAnalyticsAggregate {
  const db = getDbInstance();

  type StatsRow = {
    total: number;
    today: number;
    errors: number;
    avg_duration: number | null;
    cached: number;
  };

  const statsRow = db
    .prepare(
      `SELECT
         COUNT(*) as total,
         COALESCE(SUM(CASE WHEN timestamp >= ? THEN 1 ELSE 0 END), 0) as today,
         COALESCE(SUM(CASE WHEN status >= 400 OR error_summary IS NOT NULL THEN 1 ELSE 0 END), 0) as errors,
         AVG(CASE WHEN duration > 0 THEN duration END) as avg_duration,
         COALESCE(SUM(CASE WHEN duration > 0 AND duration < 5 THEN 1 ELSE 0 END), 0) as cached
       FROM call_logs
       WHERE request_type = 'search'`
    )
    .get(todayStartIso) as StatsRow | undefined;

  const byProvider = db
    .prepare(
      `SELECT provider, COUNT(*) as count
       FROM call_logs
       WHERE request_type = 'search'
       GROUP BY provider
       ORDER BY count DESC`
    )
    .all() as Array<{ provider: string; count: number }>;

  return {
    total: statsRow?.total ?? 0,
    today: statsRow?.today ?? 0,
    errors: statsRow?.errors ?? 0,
    avgDurationMs: Math.round(statsRow?.avg_duration ?? 0),
    cached: statsRow?.cached ?? 0,
    byProvider,
  };
}

export interface SearchProviderStat {
  provider: string;
  requests: number;
  avg_latency_ms: number;
}

export function getSearchProviderStats(): SearchProviderStat[] {
  return getDbInstance()
    .prepare(
      `SELECT provider, COUNT(*) as requests,
         CAST(AVG(duration) AS INTEGER) as avg_latency_ms
       FROM call_logs
       WHERE request_type = 'search'
       GROUP BY provider`
    )
    .all() as SearchProviderStat[];
}

export interface RecentSearchRow {
  request_summary: string | null;
  provider: string | null;
  timestamp: string | null;
}

export function getRecentSearches(limit = 10): RecentSearchRow[] {
  return getDbInstance()
    .prepare(
      `SELECT request_summary, provider, timestamp
       FROM call_logs
       WHERE request_type = 'search'
       ORDER BY timestamp DESC
       LIMIT ?`
    )
    .all(limit) as RecentSearchRow[];
}

export interface ComboModelUsageRow {
  model: string | null;
  requests: number | null;
  totalTokens: number | null;
}

export function getComboModelUsage(comboName: string, sinceIso: string): ComboModelUsageRow[] {
  return getDbInstance()
    .prepare(
      `SELECT
         model,
         COUNT(*) as requests,
         SUM(COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0)) as totalTokens
       FROM call_logs
       WHERE combo_name = ?
         AND timestamp >= ?
       GROUP BY model`
    )
    .all(comboName, sinceIso) as ComboModelUsageRow[];
}

export interface ComboPerformanceRow {
  totalRequests: number | null;
  successCount: number | null;
  avgLatencyMs: number | null;
}

export function getComboPerformance(
  comboName: string,
  sinceIso: string
): ComboPerformanceRow | undefined {
  return getDbInstance()
    .prepare(
      `SELECT
         COUNT(*) as totalRequests,
         SUM(CASE WHEN status >= 200 AND status < 400 THEN 1 ELSE 0 END) as successCount,
         AVG(duration) as avgLatencyMs
       FROM call_logs
       WHERE combo_name = ?
         AND timestamp >= ?`
    )
    .get(comboName, sinceIso) as ComboPerformanceRow | undefined;
}

export interface FallbackMetricsFilters {
  sinceIso?: string | null;
  untilIso?: string | null;
  apiKeyIds?: string[];
}

/**
 * Returns aggregated counters used to compute fallback rate and requested-
 * model coverage on the analytics dashboard. Counts requests where the
 * client supplied a `requested_model` and the server resolved a different
 * `model` (i.e. fallback fired).
 */
export function getFallbackMetrics(
  filters: FallbackMetricsFilters
): Record<string, unknown> | undefined {
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

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  return getDbInstance()
    .prepare(
      `SELECT
         SUM(CASE WHEN (combo_name IS NULL OR combo_name = '') THEN 1 ELSE 0 END) as total,
         SUM(CASE WHEN requested_model IS NOT NULL AND requested_model != '' AND (combo_name IS NULL OR combo_name = '') THEN 1 ELSE 0 END) as with_requested,
         SUM(CASE
           WHEN (combo_name IS NULL OR combo_name = '')
            AND requested_model IS NOT NULL
            AND requested_model != ''
            AND model IS NOT NULL
            AND model != ''
           THEN 1 ELSE 0 END
         ) as fallback_eligible,
         SUM(CASE
           WHEN (combo_name IS NULL OR combo_name = '')
            AND requested_model IS NOT NULL
            AND requested_model != ''
            AND model IS NOT NULL
            AND model != ''
            AND LOWER(CASE WHEN instr(requested_model, '/') > 0 THEN substr(requested_model, instr(requested_model, '/') + 1) ELSE requested_model END) != LOWER(model)
           THEN 1 ELSE 0 END
         ) as fallbacks
       FROM call_logs
       ${whereClause}`
    )
    .get(params) as Record<string, unknown> | undefined;
}

export interface ComboTargetHistoryRow {
  combo_execution_key: string | null;
  combo_step_id: string | null;
  status: number | null;
  duration: number | null;
  timestamp: string | null;
}

/**
 * Returns target-level history rows for a combo, ordered so the most recent
 * sample per (executionKey, stepId) appears first. Rows where both
 * `combo_execution_key` and `combo_step_id` are blank are filtered out.
 */
export function getComboTargetHistory(
  comboName: string,
  sinceIso: string
): ComboTargetHistoryRow[] {
  return getDbInstance()
    .prepare(
      `SELECT
         combo_execution_key,
         combo_step_id,
         status,
         duration,
         timestamp
       FROM call_logs
       WHERE combo_name = ?
         AND timestamp >= ?
         AND COALESCE(NULLIF(combo_execution_key, ''), NULLIF(combo_step_id, '')) IS NOT NULL
       ORDER BY combo_execution_key ASC, combo_step_id ASC, timestamp DESC`
    )
    .all(comboName, sinceIso) as ComboTargetHistoryRow[];
}
