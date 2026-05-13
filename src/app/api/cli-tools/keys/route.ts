import { NextResponse } from "next/server";
import { requireCliToolsAuth } from "@/lib/api/requireCliToolsAuth";
import { getApiKeys } from "@/lib/localDb";
import { maskStoredApiKey } from "@/lib/apiKeyExposure";

// Backwards-compat: previous versions of this endpoint returned the plaintext
// API key in `rawKey` for any session-authenticated user. That value has been
// removed by default. Operators who relied on the legacy behavior can opt back
// in with ALLOW_CLI_TOOLS_RAW_KEYS=true, but we surface a one-time warning at
// module load so the regression is auditable.
if (process.env.ALLOW_CLI_TOOLS_RAW_KEYS === "true") {
  console.warn(
    "[cli-tools/keys] ALLOW_CLI_TOOLS_RAW_KEYS=true is set but the response no longer includes plaintext API keys; the flag is accepted for backwards compatibility only and is a no-op."
  );
}

type CliKeyRow = Awaited<ReturnType<typeof getApiKeys>>[number] & {
  keyPrefix?: unknown;
  key_prefix?: unknown;
};

function computeKeyPrefix(row: CliKeyRow): string | null {
  const explicit =
    typeof row.keyPrefix === "string"
      ? row.keyPrefix
      : typeof row.key_prefix === "string"
        ? row.key_prefix
        : null;
  if (explicit && explicit.length > 0) return explicit;
  if (typeof row.key === "string" && row.key.length > 0) {
    return row.key.length <= 12 ? row.key : `${row.key.slice(0, 12)}...`;
  }
  return null;
}

/**
 * GET /api/cli-tools/keys
 *
 * Lists API keys for the CLI tools UI. The response intentionally OMITS the
 * plaintext `rawKey`; only a masked representation (`key`) and an opaque
 * `keyPrefix` are returned. Keep this shape stable so existing consumers don't
 * break, even though the plaintext field is now zeroed out.
 */
export async function GET(request: Request) {
  const authError = await requireCliToolsAuth(request);
  if (authError) return authError;

  try {
    const keys = await getApiKeys();
    const cliToolKeys = keys.map((key) => {
      const row = key as CliKeyRow;
      const keyPrefix = computeKeyPrefix(row);
      return {
        ...row,
        // SECURITY: do not expose plaintext API keys from the management surface.
        // Field preserved (set to null) for backwards-compatible response shape.
        rawKey: null,
        keyPrefix,
        key: maskStoredApiKey(row.key as string),
      };
    });
    return NextResponse.json({ keys: cliToolKeys, total: cliToolKeys.length });
  } catch (error) {
    console.log("Error fetching CLI tool keys:", error);
    return NextResponse.json({ error: "Failed to fetch CLI tool keys" }, { status: 500 });
  }
}
