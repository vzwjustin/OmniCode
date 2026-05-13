import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { getRuntimePorts } from "@/lib/runtime/ports";
import { updateSettingsSchema } from "@/shared/validation/settingsSchemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { validateProxyUrl, upsertUpstreamProxyConfig } from "@/lib/db/upstreamProxy";
import {
  ensurePersistentManagementPasswordHash,
  getStoredManagementPassword,
  hasManagementPasswordConfigured,
  hashManagementPassword,
  verifyManagementPassword,
} from "@/lib/auth/managementPassword";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const settings = await getSettings();
    const { password, ...safeSettings } = settings;

    const runtimePorts = getRuntimePorts();
    // Cloud URL resolution order: env vars take precedence (for ops that
    // hard-code it), then the persisted DB setting so the dashboard can
    // configure it without an env edit + restart. This is what makes cloud
    // sync configurable from the UI alone.
    const envCloudUrl = process.env.CLOUD_URL || process.env.NEXT_PUBLIC_CLOUD_URL || null;
    const storedCloudUrl =
      typeof settings.cloudUrl === "string" && settings.cloudUrl.trim().length > 0
        ? settings.cloudUrl.trim()
        : null;
    const cloudUrl = envCloudUrl || storedCloudUrl;
    const cloudUrlSource = envCloudUrl ? "env" : storedCloudUrl ? "settings" : null;
    const machineId = await getConsistentMachineId();

    return NextResponse.json({
      ...safeSettings,
      hasPassword: hasManagementPasswordConfigured(settings),
      runtimePorts,
      apiPort: runtimePorts.apiPort,
      dashboardPort: runtimePorts.dashboardPort,
      cloudConfigured: Boolean(cloudUrl),
      cloudUrl,
      // Tells the UI whether the URL is coming from env (read-only) or from
      // the DB (editable in-place). Lets us hide the editor when ops has
      // pinned it at the env layer.
      cloudUrlSource,
      machineId,
    });
  } catch (error) {
    console.log("Error getting settings:", error);
    return NextResponse.json({ error: "Failed to load settings" }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const rawBody = await request.json();

    // Zod validation
    const validation = validateBody(updateSettingsSchema, rawBody);
    if (isValidationFailure(validation)) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const body: typeof validation.data & { password?: string } = { ...validation.data };

    // If updating password, hash it
    if (body.newPassword) {
      const settings = await getSettings();
      const passwordState = await ensurePersistentManagementPasswordHash({
        settings,
        source: "settings.password_change",
      });
      const currentHash = getStoredManagementPassword(passwordState.settings);

      if (currentHash) {
        if (!body.currentPassword) {
          return NextResponse.json({ error: "Current password required" }, { status: 400 });
        }
        const isValid = await verifyManagementPassword(body.currentPassword, currentHash);
        if (!isValid) {
          return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
        }
      }

      body.password = await hashManagementPassword(body.newPassword);
      delete body.newPassword;
      delete body.currentPassword;
    }

    const settings = await updateSettings(body);

    // Sync CLIProxyAPI settings to upstream_proxy_config table
    const cpaUrl = rawBody.cliproxyapi_url as string | undefined;
    const cpaFallback = rawBody.cliproxyapi_fallback_enabled as boolean | undefined;
    if (cpaUrl && typeof cpaUrl === "string") {
      const urlValidation = validateProxyUrl(cpaUrl);
      if (urlValidation.valid === false) {
        return NextResponse.json(
          { error: `Invalid CLIProxyAPI URL: ${urlValidation.error}` },
          { status: 400 }
        );
      }
    }

    if (cpaFallback !== undefined || cpaUrl !== undefined) {
      const enabled =
        cpaFallback ?? (settings as Record<string, unknown>).cliproxyapi_fallback_enabled;
      const mode = enabled ? "fallback" : "native";
      await upsertUpstreamProxyConfig({
        providerId: "cliproxyapi",
        mode,
        enabled: !!enabled,
      });
    }

    const { password, ...safeSettings } = settings;
    return NextResponse.json(safeSettings);
  } catch (error) {
    console.log("Error updating settings:", error);
    return NextResponse.json({ error: "Failed to update settings" }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  return PATCH(request);
}
