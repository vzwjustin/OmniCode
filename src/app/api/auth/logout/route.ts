import { NextResponse } from "next/server";
import { decodeJwt } from "jose";
import { getAuditRequestContext, logAuditEvent } from "@/lib/compliance/index";
import { cookies } from "next/headers";
import { denyJti } from "@/lib/auth/sessionRegistry";

export const logoutRouteInternals = {
  getCookieStore: cookies,
};

export async function POST(request) {
  const auditContext = getAuditRequestContext(request);
  const cookieStore = await logoutRouteInternals.getCookieStore();

  // Best-effort: read the current cookie and add its jti to the deny set so
  // an attacker holding a copy cannot reuse it after logout. We deliberately
  // do NOT verify the signature here — we just want the jti/exp claims.
  try {
    const token = cookieStore.get?.("auth_token")?.value;
    if (token) {
      const payload = decodeJwt(token);
      const jti = typeof payload.jti === "string" ? payload.jti : null;
      const exp = typeof payload.exp === "number" ? payload.exp : null;
      if (jti && exp) {
        denyJti(jti, exp * 1000);
      }
    }
  } catch {
    // Malformed token — nothing to deny. Continue with cookie deletion.
  }

  cookieStore.delete("auth_token");
  logAuditEvent({
    action: "auth.logout.success",
    actor: "admin",
    target: "dashboard-auth",
    resourceType: "auth_session",
    status: "success",
    ipAddress: auditContext.ipAddress || undefined,
    requestId: auditContext.requestId,
  });
  return NextResponse.json({ success: true });
}
