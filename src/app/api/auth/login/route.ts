import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getAuditRequestContext, logAuditEvent } from "@/lib/compliance/index";
import { getSettings } from "@/lib/localDb";
import { SignJWT } from "jose";
import { cookies } from "next/headers";
import {
  ensurePersistentManagementPasswordHash,
  getStoredManagementPassword,
  isPasswordMustRotate,
  verifyManagementPassword,
} from "@/lib/auth/managementPassword";
import { loginSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { checkLoginGuard, clearLoginAttempts, recordLoginFailure } from "@/server/auth/loginGuard";

// SECURITY: No hardcoded fallback — JWT_SECRET must be configured.
if (!process.env.JWT_SECRET) {
  console.error("[SECURITY] FATAL: JWT_SECRET is not set. Login authentication is disabled.");
}

function getJwtSecret(): Uint8Array {
  return new TextEncoder().encode(process.env.JWT_SECRET || "");
}

function getSessionTtlDays(): number {
  const raw = process.env.OMNIROUTE_SESSION_TTL_DAYS;
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 7;
}

// Test seam for cookie store injection without affecting runtime behavior.
export const authRouteInternals = {
  getCookieStore: cookies,
};

export async function POST(request) {
  const auditContext = getAuditRequestContext(request);

  try {
    // Fail-fast if JWT_SECRET is not configured
    if (!process.env.JWT_SECRET) {
      logAuditEvent({
        action: "auth.login.misconfigured",
        actor: "system",
        target: "dashboard-auth",
        resourceType: "auth_session",
        status: "failed",
        ipAddress: auditContext.ipAddress || undefined,
        requestId: auditContext.requestId,
        metadata: { reason: "missing_jwt_secret" },
      });
      return NextResponse.json(
        { error: "Server misconfigured: JWT_SECRET not set. Contact administrator." },
        { status: 500 }
      );
    }

    const rawBody = await request.json();

    // Zod validation
    const validation = validateBody(loginSchema, rawBody);
    if (isValidationFailure(validation)) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const password = typeof validation.data.password === "string" ? validation.data.password : "";
    if (!password) {
      return NextResponse.json({ error: "Invalid password payload" }, { status: 400 });
    }
    const settings = await getSettings();
    const bruteForceEnabled = settings.bruteForceProtection !== false;
    const clientIp = auditContext.ipAddress || null;

    const guardCheck = checkLoginGuard(clientIp, { enabled: bruteForceEnabled });
    if (!guardCheck.allowed) {
      logAuditEvent({
        action: "auth.login.locked",
        actor: "anonymous",
        target: "dashboard-auth",
        resourceType: "auth_session",
        status: "failed",
        ipAddress: clientIp || undefined,
        requestId: auditContext.requestId,
        metadata: { retryAfterSeconds: guardCheck.retryAfterSeconds || 0 },
      });
      return NextResponse.json(
        { error: "Too many failed attempts. Try again later." },
        {
          status: 429,
          headers: guardCheck.retryAfterSeconds
            ? { "Retry-After": String(guardCheck.retryAfterSeconds) }
            : {},
        }
      );
    }

    const passwordState = await ensurePersistentManagementPasswordHash({
      settings,
      source: "auth.login",
    });
    const storedHash = getStoredManagementPassword(passwordState.settings);

    if (!storedHash) {
      logAuditEvent({
        action: "auth.login.setup_required",
        actor: "anonymous",
        target: "dashboard-auth",
        resourceType: "auth_session",
        status: "failed",
        ipAddress: auditContext.ipAddress || undefined,
        requestId: auditContext.requestId,
        metadata: { reason: "missing_persisted_password" },
      });
      return NextResponse.json(
        { error: "No password configured. Complete onboarding first.", needsSetup: true },
        { status: 403 }
      );
    }

    const isValid = await verifyManagementPassword(password, storedHash);

    if (isValid) {
      const forceSecureCookie = process.env.AUTH_COOKIE_SECURE === "true";
      const forwardedProtoHeader = request.headers.get("x-forwarded-proto") || "";
      const forwardedProto = forwardedProtoHeader.split(",")[0].trim().toLowerCase();
      const isHttpsRequest = forwardedProto === "https" || request.nextUrl?.protocol === "https:";
      const useSecureCookie = forceSecureCookie || isHttpsRequest;

      // FIX 5: If the persisted password was migrated from INITIAL_PASSWORD (or
      // otherwise flagged as a temporary bootstrap credential), do NOT issue a
      // full session. Instead, return a short-lived token authorized only for
      // the change-password endpoint so the operator is forced to rotate.
      const mustRotate = isPasswordMustRotate(passwordState.settings);
      if (mustRotate) {
        const tempToken = await new SignJWT({
          purpose: "change-password",
          jti: randomUUID(),
        })
          .setProtectedHeader({ alg: "HS256" })
          .setExpirationTime("5m")
          .sign(getJwtSecret());

        logAuditEvent({
          action: "auth.login.must_rotate",
          actor: "admin",
          target: "dashboard-auth",
          resourceType: "auth_session",
          status: "success",
          ipAddress: auditContext.ipAddress || undefined,
          requestId: auditContext.requestId,
          metadata: {
            reason: "password_must_rotate",
            passwordMigrated: passwordState.migrated,
          },
        });

        clearLoginAttempts(clientIp);
        return NextResponse.json({
          success: true,
          mustChangePassword: true,
          tempToken,
        });
      }

      const ttlDays = getSessionTtlDays();
      const ttlSeconds = ttlDays * 24 * 60 * 60;
      const jti = randomUUID();
      const token = await new SignJWT({ authenticated: true, jti })
        .setProtectedHeader({ alg: "HS256" })
        .setExpirationTime(`${ttlDays}d`)
        .sign(getJwtSecret());

      const cookieStore = await authRouteInternals.getCookieStore();
      cookieStore.set("auth_token", token, {
        httpOnly: true,
        secure: useSecureCookie,
        sameSite: "lax",
        path: "/",
        maxAge: ttlSeconds,
      });

      logAuditEvent({
        action: "auth.login.success",
        actor: "admin",
        target: "dashboard-auth",
        resourceType: "auth_session",
        status: "success",
        ipAddress: auditContext.ipAddress || undefined,
        requestId: auditContext.requestId,
        metadata: {
          hasStoredPassword: Boolean(storedHash),
          passwordMigrated: passwordState.migrated,
          secureCookie: useSecureCookie,
        },
      });

      clearLoginAttempts(clientIp);
      return NextResponse.json({ success: true });
    }

    const failureDecision = recordLoginFailure(clientIp, { enabled: bruteForceEnabled });

    logAuditEvent({
      action: "auth.login.failed",
      actor: "anonymous",
      target: "dashboard-auth",
      resourceType: "auth_session",
      status: "failed",
      ipAddress: auditContext.ipAddress || undefined,
      requestId: auditContext.requestId,
      metadata: { reason: "invalid_password", lockedOut: failureDecision.allowed === false },
    });

    if (!failureDecision.allowed) {
      return NextResponse.json(
        { error: "Too many failed attempts. Try again later." },
        {
          status: 429,
          headers: failureDecision.retryAfterSeconds
            ? { "Retry-After": String(failureDecision.retryAfterSeconds) }
            : {},
        }
      );
    }

    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  } catch (error) {
    // Scrub any $2[aby]$... bcrypt hash from the message before logging.
    // bcryptjs occasionally surfaces the hash in error messages when a malformed
    // hash is encountered; we never want that in stdout/log aggregators.
    const rawMessage = error instanceof Error ? error.message : "unknown_error";
    const safeMessage = rawMessage.replace(/\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/g, "[bcrypt-hash-redacted]");
    console.error("[AUTH] Login failed:", safeMessage);
    logAuditEvent({
      action: "auth.login.error",
      actor: "system",
      target: "dashboard-auth",
      resourceType: "auth_session",
      status: "failed",
      ipAddress: auditContext.ipAddress || undefined,
      requestId: auditContext.requestId,
      metadata: {
        message: safeMessage,
      },
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
