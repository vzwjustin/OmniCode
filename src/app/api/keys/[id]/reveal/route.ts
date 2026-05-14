import { NextResponse } from "next/server";
import { getApiKeyById } from "@/lib/localDb";
import { isApiKeyRevealEnabled } from "@/lib/apiKeyExposure";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { logAuditEvent } from "@/lib/compliance";
import { getClientIpFromRequest } from "@/lib/ipUtils";
import * as log from "@/sse/utils/logger";

// GET /api/keys/[id]/reveal - Reveal full API key for explicit copy actions
export async function GET(request, { params }) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const { id } = await params;
  const ipAddress = getClientIpFromRequest(request);

  try {
    if (!isApiKeyRevealEnabled()) {
      logAuditEvent({
        action: "apiKey.reveal.denied",
        target: id,
        resourceType: "api_key",
        status: "denied",
        details: { reason: "reveal_disabled" },
        ipAddress,
      });
      return NextResponse.json({ error: "API key reveal is disabled" }, { status: 403 });
    }

    const key = await getApiKeyById(id);

    if (!key || typeof key.key !== "string") {
      logAuditEvent({
        action: "apiKey.reveal.notFound",
        target: id,
        resourceType: "api_key",
        status: "not_found",
        ipAddress,
      });
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    logAuditEvent({
      action: "apiKey.reveal",
      target: id,
      resourceType: "api_key",
      status: "success",
      ipAddress,
    });
    return NextResponse.json({ key: key.key });
  } catch (error) {
    log.error("keys", "Error revealing key", error);
    logAuditEvent({
      action: "apiKey.reveal.error",
      target: id,
      resourceType: "api_key",
      status: "error",
      details: { message: error instanceof Error ? error.message : String(error) },
      ipAddress,
    });
    return NextResponse.json({ error: "Failed to reveal key" }, { status: 500 });
  }
}
