import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { createProviderNode, getProviderNodes } from "@/models";
import {
  OPENAI_COMPATIBLE_PREFIX,
  ANTHROPIC_COMPATIBLE_PREFIX,
  CLAUDE_CODE_COMPATIBLE_PREFIX,
} from "@/shared/constants/providers";
import { validateOutboundUrl } from "@/shared/network/safeOutboundFetch";
import { generateId } from "@/shared/utils";
import { isCcCompatibleProviderEnabled } from "@/shared/utils/featureFlags";
import { createProviderNodeSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

const TRUE_ENV = new Set(["1", "true", "yes", "on"]);

function arePrivateBaseUrlsAllowed(): boolean {
  const value = process.env.OMNIROUTE_ALLOW_PRIVATE_BASEURLS;
  return !!value && TRUE_ENV.has(value.trim().toLowerCase());
}

const OPENAI_COMPATIBLE_DEFAULTS = {
  baseUrl: "https://api.openai.com/v1",
};

const ANTHROPIC_COMPATIBLE_DEFAULTS = {
  baseUrl: "https://api.anthropic.com/v1",
};

function sanitizeAnthropicBaseUrl(baseUrl: string) {
  return (baseUrl || "")
    .trim()
    .replace(/\/$/, "")
    .replace(/\/messages(?:\?[^#]*)?$/i, "");
}

function sanitizeClaudeCodeCompatibleBaseUrl(baseUrl: string) {
  return (baseUrl || "")
    .trim()
    .replace(/\/$/, "")
    .replace(/\/(?:v\d+\/)?messages(?:\?[^#]*)?$/i, "");
}

// GET /api/provider-nodes - List all provider nodes
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const nodes = await getProviderNodes();
    return NextResponse.json({
      nodes,
      ccCompatibleProviderEnabled: isCcCompatibleProviderEnabled(),
    });
  } catch (error) {
    console.log("Error fetching provider nodes:", error);
    return NextResponse.json({ error: "Failed to fetch provider nodes" }, { status: 500 });
  }
}

// POST /api/provider-nodes - Create provider node
export async function POST(request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

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

  try {
    const validation = validateBody(createProviderNodeSchema, rawBody);
    if (isValidationFailure(validation)) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const { name, prefix, apiType, baseUrl, type, compatMode, chatPath, modelsPath } =
      validation.data;

    // Determine type
    const nodeType = type || "openai-compatible";

    if (nodeType === "openai-compatible") {
      const finalBaseUrl = (baseUrl || OPENAI_COMPATIBLE_DEFAULTS.baseUrl).trim();

      // SSRF guard — reject base URLs that resolve to private/loopback/IMDS.
      if (!arePrivateBaseUrlsAllowed()) {
        const check = await validateOutboundUrl(finalBaseUrl, "public-only");
        if (check.ok === false) {
          return NextResponse.json(
            { error: "blocked_baseurl", reason: check.reason },
            { status: 400 }
          );
        }
      }

      const node = await createProviderNode({
        id: `${OPENAI_COMPATIBLE_PREFIX}${apiType}-${generateId()}`,
        type: "openai-compatible",
        prefix: prefix.trim(),
        apiType,
        baseUrl: finalBaseUrl,
        name: name.trim(),
        chatPath: chatPath || null,
        modelsPath: modelsPath || null,
      });
      return NextResponse.json({ node }, { status: 201 });
    }

    if (nodeType === "anthropic-compatible") {
      if (compatMode === "cc" && !isCcCompatibleProviderEnabled()) {
        return NextResponse.json({ error: "CC Compatible provider is disabled" }, { status: 403 });
      }

      const rawBaseUrl = baseUrl || ANTHROPIC_COMPATIBLE_DEFAULTS.baseUrl;
      const sanitizedBaseUrl =
        compatMode === "cc"
          ? sanitizeClaudeCodeCompatibleBaseUrl(rawBaseUrl)
          : sanitizeAnthropicBaseUrl(rawBaseUrl);

      // SSRF guard — reject base URLs that resolve to private/loopback/IMDS.
      if (!arePrivateBaseUrlsAllowed()) {
        const check = await validateOutboundUrl(sanitizedBaseUrl, "public-only");
        if (check.ok === false) {
          return NextResponse.json(
            { error: "blocked_baseurl", reason: check.reason },
            { status: 400 }
          );
        }
      }

      const node = await createProviderNode({
        id:
          compatMode === "cc"
            ? `${CLAUDE_CODE_COMPATIBLE_PREFIX}${generateId()}`
            : `${ANTHROPIC_COMPATIBLE_PREFIX}${generateId()}`,
        type: "anthropic-compatible",
        prefix: prefix.trim(),
        baseUrl: sanitizedBaseUrl,
        name: name.trim(),
        chatPath: chatPath || null,
        modelsPath: compatMode === "cc" ? null : modelsPath || null,
      });
      return NextResponse.json({ node }, { status: 201 });
    }

    return NextResponse.json({ error: "Invalid provider node type" }, { status: 400 });
  } catch (error) {
    console.log("Error creating provider node:", error);
    return NextResponse.json({ error: "Failed to create provider node" }, { status: 500 });
  }
}
