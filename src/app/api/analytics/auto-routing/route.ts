import { NextResponse } from "next/server";
import { getAutoRoutingStats } from "@/lib/db/usageLogs";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";

export const dynamic = "force-dynamic";

/**
 * GET /api/analytics/auto-routing
 * Returns auto-routing usage statistics and metrics.
 */
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  try {
    return NextResponse.json(getAutoRoutingStats());
  } catch (error) {
    console.error("Auto-routing analytics error:", error);
    return NextResponse.json({
      totalRequests: 0,
      variantBreakdown: {},
      topProviders: [],
    });
  }
}
