/**
 * GET /api/v1/search/analytics
 *
 * Returns search request statistics from call_logs (request_type = 'search').
 * Includes provider breakdown, cache hit rate, cost summary, and error count.
 */

import { NextResponse } from "next/server";
import { SEARCH_PROVIDERS } from "@omniroute/open-sse/config/searchRegistry.ts";
import { getSearchAnalytics } from "@/lib/usage/callLogAggregates";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";

export async function GET(req: Request) {
  const policy = await enforceApiKeyPolicy(req, "analytics");
  if (policy.rejection) return policy.rejection;

  try {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const stats = getSearchAnalytics(todayStart.toISOString());

    const byProvider: Record<string, { count: number; costUsd: number }> = {};
    let totalCostUsd = 0;
    for (const row of stats.byProvider) {
      const costPerQuery = SEARCH_PROVIDERS[row.provider]?.costPerQuery ?? 0;
      const cost = costPerQuery * row.count;
      byProvider[row.provider] = { count: row.count, costUsd: cost };
      totalCostUsd += cost;
    }

    const cacheHitRate = stats.total > 0 ? Math.round((stats.cached / stats.total) * 100) : 0;

    return NextResponse.json({
      total: stats.total,
      today: stats.today,
      cached: stats.cached,
      errors: stats.errors,
      totalCostUsd,
      byProvider,
      cacheHitRate,
      avgDurationMs: stats.avgDurationMs,
      last24h: [],
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[/api/v1/search/analytics]", msg);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
