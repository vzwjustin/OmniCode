import { getProviderConnections, updateProviderConnection, getSettings } from "@/lib/localDb";
import { buildConfigSyncEnvelope, toLegacyCloudSyncPayload } from "@/lib/sync/bundle";

// Env-pinned cloud URL (highest precedence). When unset, callers should fall
// back to the persisted `settings.cloudUrl` via resolveCloudUrl().
const CLOUD_URL_ENV = process.env.CLOUD_URL || process.env.NEXT_PUBLIC_CLOUD_URL || null;
const CLOUD_SYNC_TIMEOUT_MS = Number(process.env.CLOUD_SYNC_TIMEOUT_MS || 12000);

/**
 * Resolve the effective cloud URL: prefer env (CLOUD_URL /
 * NEXT_PUBLIC_CLOUD_URL), otherwise the persisted dashboard setting.
 *
 * This lets operators choose between hard-coding the URL at deploy time and
 * letting end-users configure it from the dashboard without an env edit +
 * restart. Returns `null` if neither source provides a value.
 */
export async function resolveCloudUrl(): Promise<string | null> {
  if (CLOUD_URL_ENV) return CLOUD_URL_ENV;
  try {
    const settings = await getSettings();
    const stored = typeof settings?.cloudUrl === "string" ? settings.cloudUrl.trim() : "";
    return stored.length > 0 ? stored : null;
  } catch {
    return null;
  }
}

// Backwards-compat export — older modules import CLOUD_URL directly. When the
// URL is set via the dashboard, this will be `null` and callers MUST use
// resolveCloudUrl() instead.
const CLOUD_URL = CLOUD_URL_ENV;

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function toDateMs(value: unknown): number {
  if (typeof value === "string" || typeof value === "number" || value instanceof Date) {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export async function fetchWithTimeout(url, options = {}, timeoutMs = CLOUD_SYNC_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Sync data to Cloud (shared utility)
 * @param {string} machineId
 * @param {string|null} createdKey - Key created during enable
 */
export async function syncToCloud(machineId, createdKey = null) {
  const effectiveCloudUrl = await resolveCloudUrl();
  if (!effectiveCloudUrl) {
    return {
      error:
        "Cloud URL is not configured. Set it in Settings → Cloud (or define CLOUD_URL / NEXT_PUBLIC_CLOUD_URL in your environment).",
    };
  }

  // Keep legacy field names for upstream compatibility, but derive them
  // from a canonical sync bundle with deterministic version hashing.
  const { version, bundle } = await buildConfigSyncEnvelope();
  const legacyPayload = toLegacyCloudSyncPayload(bundle);

  let response;
  try {
    // Send to Cloud
    response = await fetchWithTimeout(`${effectiveCloudUrl}/sync/${machineId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...legacyPayload,
        version,
      }),
    });
  } catch (error) {
    const isTimeout = error?.name === "AbortError";
    return { error: isTimeout ? "Cloud sync timeout" : "Cloud sync request failed" };
  }

  if (!response.ok) {
    const errorText = await response.text();
    const truncated = errorText.length > 200 ? errorText.slice(0, 200) + "…" : errorText;
    console.log(`Cloud sync failed (${response.status}):`, truncated);
    return { error: "Cloud sync failed" };
  }

  const result = await response.json();

  // Update local db with tokens from Cloud (providers stored by ID)
  if (result.data && result.data.providers) {
    await updateLocalTokens(result.data.providers);
  }

  const responseData: any = {
    success: true,
    message: "Synced successfully",
    changes: result.changes,
    version,
  };

  if (createdKey) {
    responseData.createdKey = createdKey;
  }

  return responseData;
}

/**
 * Update local db with data from Cloud
 * Simple logic: if Cloud is newer, sync entire provider
 * cloudProviders is object keyed by provider ID
 */
async function updateLocalTokens(cloudProviders: unknown) {
  const cloudProvidersMap = asRecord(cloudProviders);
  const localProviders = await getProviderConnections();

  for (const localProviderRaw of localProviders as unknown[]) {
    const localProvider = asRecord(localProviderRaw);
    const localProviderId = toStringOrNull(localProvider.id);
    if (!localProviderId) continue;

    const cloudProvider = asRecord(cloudProvidersMap[localProviderId]);
    if (Object.keys(cloudProvider).length === 0) continue;

    const cloudUpdatedAt = toDateMs(cloudProvider.updatedAt);
    const localUpdatedAt = toDateMs(localProvider.updatedAt);

    // Simple logic: if Cloud is newer, sync entire provider
    if (cloudUpdatedAt > localUpdatedAt) {
      const updates = {
        // Tokens
        accessToken: cloudProvider.accessToken,
        refreshToken: cloudProvider.refreshToken,
        expiresAt: cloudProvider.expiresAt,
        expiresIn: cloudProvider.expiresIn,

        // Provider specific data
        providerSpecificData:
          cloudProvider.providerSpecificData || localProvider.providerSpecificData,

        // Status fields
        testStatus: cloudProvider.status || "active",
        lastError: cloudProvider.lastError,
        lastErrorAt: cloudProvider.lastErrorAt,
        errorCode: cloudProvider.errorCode,
        rateLimitedUntil: cloudProvider.rateLimitedUntil,

        // Metadata
        updatedAt: cloudProvider.updatedAt,
      };

      await updateProviderConnection(localProviderId, updates);
    }
  }
}

export { CLOUD_URL, CLOUD_SYNC_TIMEOUT_MS };
