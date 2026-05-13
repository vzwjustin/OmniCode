import { NextResponse } from "next/server";
import { verifyExtractionPipeline } from "@/lib/memory/verify";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";

/**
 * Health probe for the memory extraction pipeline. Even though this looks
 * read-only, the probe performs LLM calls and can be used to enumerate the
 * configured provider stack from an unauthenticated client. Gate it behind
 * `requireManagementAuth` like the rest of the memory surface.
 */
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const result = await verifyExtractionPipeline("health-check");
    return NextResponse.json(result);
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ working: false, latencyMs: 0, error }, { status: 500 });
  }
}
