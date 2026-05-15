import { NextResponse } from "next/server";
import { getProviderMetrics } from "@/lib/usage/callLogAggregates";

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/**
 * GET /api/providers/metrics — Aggregate per-provider stats from call_logs
 * Returns: { metrics: { [provider]: { totalRequests, totalSuccesses, successRate, avgLatencyMs } } }
 */
export async function GET() {
  try {
    const rows = getProviderMetrics();

    const metrics: Record<
      string,
      {
        totalRequests: number;
        totalSuccesses: number;
        successRate: number;
        avgLatencyMs: number;
      }
    > = {};
    for (const row of rows) {
      const provider =
        typeof row.provider === "string" && row.provider.trim().length > 0
          ? row.provider
          : "unknown";
      const totalRequests = toNumber(row.totalRequests);
      const totalSuccesses = toNumber(row.totalSuccesses);
      const avgLatencyMs = toNumber(row.avgLatencyMs);
      metrics[provider] = {
        totalRequests,
        totalSuccesses,
        successRate: totalRequests > 0 ? Math.round((totalSuccesses / totalRequests) * 100) : 0,
        avgLatencyMs,
      };
    }

    return NextResponse.json({ metrics });
  } catch (error) {
    console.error("[providers/metrics] Error:", error);
    return NextResponse.json({ metrics: {} });
  }
}
