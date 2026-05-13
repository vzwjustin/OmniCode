import { NextResponse } from "next/server";
import { validateApiKey, getProviderConnections, updateProviderConnection } from "@/models";
import { cloudCredentialUpdateSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { getApiKeyMetadata } from "@/lib/db/apiKeys";
import { hasManageScope } from "@/lib/api/requireManagementAuth";
import { logAuditEvent } from "@/lib/compliance/index";

function getClientIp(request: Request): string | undefined {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() || undefined;
  return request.headers.get("x-real-ip") || undefined;
}

/**
 * PUT /api/cloud/credentials/update
 *
 * Rotates OAuth (or API-key) credentials for a provider connection. This is a
 * privileged management operation: previously any valid client API key could
 * rotate tokens for any provider, which is a credential-takeover primitive. We
 * now require the caller's API key to carry the `manage` scope and we emit an
 * audit_log entry for every rotation attempt (success or failure).
 */
export async function PUT(request: Request) {
  let rawBody;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      {
        error: {
          message: "Invalid request",
          details: [{ field: "body", message: "Invalid JSON body" }],
        },
      },
      { status: 400 }
    );
  }

  const ipAddress = getClientIp(request);

  try {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Missing API key" }, { status: 401 });
    }

    const apiKey = authHeader.slice(7);
    const validation = validateBody(cloudCredentialUpdateSchema, rawBody);
    if (isValidationFailure(validation)) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const { provider, credentials } = validation.data;

    // Validate API key
    const isValid = await validateApiKey(apiKey);
    if (!isValid) {
      logAuditEvent({
        action: "cloud.credentials.update.denied",
        actor: "unknown",
        target: provider,
        resourceType: "provider_connection",
        status: "denied",
        details: { reason: "invalid_api_key" },
        ipAddress,
      });
      return NextResponse.json({ error: "Invalid API key" }, { status: 401 });
    }

    // SECURITY: only callers with the `manage` scope may rotate OAuth tokens.
    const metadata = await getApiKeyMetadata(apiKey);
    const actor = metadata?.id || "unknown";
    if (!metadata || !hasManageScope(metadata.scopes || [])) {
      logAuditEvent({
        action: "cloud.credentials.update.denied",
        actor,
        target: provider,
        resourceType: "provider_connection",
        status: "denied",
        details: { reason: "missing_manage_scope" },
        ipAddress,
      });
      return NextResponse.json(
        { error: "API key lacks 'manage' scope" },
        { status: 403 }
      );
    }

    // Find active connection for provider
    const connections = await getProviderConnections({ provider, isActive: true });
    const connection = connections[0];

    if (!connection) {
      logAuditEvent({
        action: "cloud.credentials.update.denied",
        actor,
        target: provider,
        resourceType: "provider_connection",
        status: "not_found",
        details: { reason: "no_active_connection" },
        ipAddress,
      });
      return NextResponse.json(
        { error: `No active connection found for provider: ${provider}` },
        { status: 404 }
      );
    }

    // Update credentials
    const updateData: Record<string, unknown> = {};
    const rotatedFields: string[] = [];
    if (credentials.accessToken) {
      updateData.accessToken = credentials.accessToken;
      rotatedFields.push("accessToken");
    }
    if (credentials.refreshToken) {
      updateData.refreshToken = credentials.refreshToken;
      rotatedFields.push("refreshToken");
    }
    if (credentials.expiresIn) {
      updateData.expiresAt = new Date(Date.now() + credentials.expiresIn * 1000).toISOString();
      rotatedFields.push("expiresAt");
    }

    const connectionId = typeof connection.id === "string" ? connection.id : null;
    if (!connectionId) {
      return NextResponse.json({ error: "Invalid provider connection ID" }, { status: 500 });
    }
    await updateProviderConnection(connectionId, updateData);

    logAuditEvent({
      action: "cloud.credentials.update",
      actor,
      target: provider,
      resourceType: "provider_connection",
      status: "success",
      details: { connectionId, rotatedFields },
      ipAddress,
    });

    return NextResponse.json({
      success: true,
      message: `Credentials updated for provider: ${provider}`,
    });
  } catch (error) {
    console.log("Update credentials error:", error);
    logAuditEvent({
      action: "cloud.credentials.update.error",
      actor: "unknown",
      resourceType: "provider_connection",
      status: "error",
      details: { message: error instanceof Error ? error.message : String(error) },
      ipAddress,
    });
    return NextResponse.json({ error: "Failed to update credentials" }, { status: 500 });
  }
}
