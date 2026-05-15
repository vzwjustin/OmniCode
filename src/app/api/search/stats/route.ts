import { NextResponse } from "next/server";
import { getCacheStats } from "@omniroute/open-sse/services/searchCache.ts";
import { SEARCH_PROVIDERS } from "@omniroute/open-sse/config/searchRegistry.ts";
import { getSearchProviderStats, getRecentSearches } from "@/lib/usage/callLogAggregates";
import { isAuthenticated } from "@/shared/utils/apiAuth";

export async function GET(request: Request) {
  if (!(await isAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const cache = getCacheStats();
    const providerStats = getSearchProviderStats();

    const providers: Record<
      string,
      { requests: number; avg_latency_ms: number; total_cost: number }
    > = {};
    for (const row of providerStats) {
      const costPerQuery = SEARCH_PROVIDERS[row.provider]?.costPerQuery || 0;
      providers[row.provider] = {
        requests: row.requests,
        avg_latency_ms: row.avg_latency_ms,
        total_cost: parseFloat((row.requests * costPerQuery).toFixed(4)),
      };
    }

    const recent_searches = getRecentSearches(10).map((row) => {
      let query = "";
      let filters = {};
      try {
        const summary = JSON.parse(row.request_summary || "{}");
        query = summary.query || "";
        filters = summary.filters || {};
      } catch {
        // Unparseable request_summary
      }
      return {
        query,
        provider: row.provider,
        timestamp: row.timestamp,
        filters,
      };
    });

    return NextResponse.json({ cache, providers, recent_searches });
  } catch (error) {
    return NextResponse.json({ error: "Failed to get stats" }, { status: 500 });
  }
}
