/**
 * db/usageLogs.ts — Aggregated reads from the `usage_logs` table.
 *
 * Used by the auto-routing analytics dashboard. Routes and handlers MUST go
 * through these helpers — never write raw SQL against `usage_logs` from
 * outside this module.
 */

import { getDbInstance } from "./core";

export interface AutoRoutingStats {
  totalRequests: number;
  variantBreakdown: Record<string, number>;
  topProviders: Array<{ provider: string; count: number }>;
}

export function getAutoRoutingStats(topProviderLimit = 10): AutoRoutingStats {
  const db = getDbInstance();

  const totalRow = db
    .prepare(
      `SELECT COUNT(*) as count
       FROM usage_logs
       WHERE model = 'auto' OR model LIKE 'auto/%'`
    )
    .get() as { count: number } | undefined;

  const variantRows = db
    .prepare(
      `SELECT
         CASE
           WHEN model = 'auto' THEN 'default'
           WHEN model LIKE 'auto/%' THEN SUBSTR(model, 6)
           ELSE 'other'
         END as variant,
         COUNT(*) as count
       FROM usage_logs
       WHERE model = 'auto' OR model LIKE 'auto/%'
       GROUP BY variant
       ORDER BY count DESC`
    )
    .all() as Array<{ variant: string; count: number }>;

  const topProviders = db
    .prepare(
      `SELECT provider, COUNT(*) as count
       FROM usage_logs
       WHERE model = 'auto' OR model LIKE 'auto/%'
       GROUP BY provider
       ORDER BY count DESC
       LIMIT ?`
    )
    .all(topProviderLimit) as Array<{ provider: string; count: number }>;

  const variantBreakdown: Record<string, number> = {};
  for (const row of variantRows) {
    variantBreakdown[row.variant] = row.count;
  }

  return {
    totalRequests: totalRow?.count ?? 0,
    variantBreakdown,
    topProviders,
  };
}
