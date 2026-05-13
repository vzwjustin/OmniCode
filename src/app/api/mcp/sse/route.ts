/**
 * MCP SSE Transport — /api/mcp/sse
 *
 * Endpoints:
 *   GET    — open SSE stream for bidirectional communication
 *   POST   — send JSON-RPC messages to the MCP server
 */

import { NextRequest, NextResponse } from "next/server";
import { getSettings } from "@/lib/db/settings";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { handleMcpSSE } from "../../../../../open-sse/mcp-server/httpTransport";

let anonymousWarningLogged = false;

function isAnonymousMcpAllowed(): boolean {
  const allowed = process.env.OMNIROUTE_MCP_ALLOW_ANONYMOUS === "true";
  if (allowed && !anonymousWarningLogged) {
    anonymousWarningLogged = true;
    // Security warning — visible in server logs so operators notice if this is set in prod.
    console.warn(
      "[SECURITY] OMNIROUTE_MCP_ALLOW_ANONYMOUS=true — MCP SSE transport is exposed without authentication."
    );
  }
  return allowed;
}

async function enforceAuth(request: NextRequest): Promise<Response | null> {
  if (isAnonymousMcpAllowed()) return null;
  return requireManagementAuth(request);
}

async function guardEnabled(): Promise<NextResponse | null> {
  const settings = await getSettings();
  if (!settings.mcpEnabled) {
    return NextResponse.json(
      { error: "MCP server is disabled. Enable it from the Endpoints page." },
      { status: 503 }
    );
  }
  const transport = (settings.mcpTransport as string) || "stdio";
  if (transport !== "sse") {
    return NextResponse.json(
      { error: `MCP transport is set to "${transport}", not "sse". Change it from Settings.` },
      { status: 400 }
    );
  }
  return null;
}

export async function GET(request: NextRequest) {
  const authError = await enforceAuth(request);
  if (authError) return authError;
  const blocked = await guardEnabled();
  if (blocked) return blocked;
  return handleMcpSSE(request);
}

export async function POST(request: NextRequest) {
  const authError = await enforceAuth(request);
  if (authError) return authError;
  const blocked = await guardEnabled();
  if (blocked) return blocked;
  return handleMcpSSE(request);
}
