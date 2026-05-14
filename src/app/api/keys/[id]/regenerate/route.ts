import { NextResponse } from "next/server";
import { regenerateApiKey } from "@/lib/localDb";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { logAuditEvent } from "@/lib/compliance";
import { getClientIpFromRequest } from "@/lib/ipUtils";
import * as log from "@/sse/utils/logger";

/**
 * POST /api/keys/[id]/regenerate
 *
 * Regenerates the API key value for a given ID.
 * The old key is immediately invalidated.
 */
export async function POST(request, { params }) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const { id } = await params;
  const ipAddress = getClientIpFromRequest(request);

  try {
    if (!id) {
      return NextResponse.json({ error: "Missing key ID" }, { status: 400 });
    }

    const result = await regenerateApiKey(id);
    if (!result) {
      logAuditEvent({
        action: "apiKey.regenerate.notFound",
        target: id,
        resourceType: "api_key",
        status: "not_found",
        ipAddress,
      });
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    logAuditEvent({
      action: "apiKey.regenerate",
      target: id,
      resourceType: "api_key",
      status: "success",
      ipAddress,
    });
    return NextResponse.json({
      message: "API key regenerated successfully",
      key: result.key,
      id: result.id,
    });
  } catch (error) {
    log.error("keys", "Error regenerating key", error);
    logAuditEvent({
      action: "apiKey.regenerate.error",
      target: id,
      resourceType: "api_key",
      status: "error",
      details: { message: error instanceof Error ? error.message : String(error) },
      ipAddress,
    });
    return NextResponse.json({ error: "Failed to regenerate key" }, { status: 500 });
  }
}
