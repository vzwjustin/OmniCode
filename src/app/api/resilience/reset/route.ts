import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";

/**
 * POST /api/resilience/reset — Reset all provider circuit breakers
 */
export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { getAllCircuitBreakerStatuses, getCircuitBreaker } =
      await import("@/shared/utils/circuitBreaker");

    const statuses = getAllCircuitBreakerStatuses();
    let resetCount = 0;

    for (const { name } of statuses) {
      const breaker = getCircuitBreaker(name);
      breaker.reset();
      resetCount++;
    }

    return NextResponse.json({
      ok: true,
      resetCount,
      message: `Reset ${resetCount} circuit breaker(s)`,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to reset resilience state";
    console.error("[API] POST /api/resilience/reset error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
