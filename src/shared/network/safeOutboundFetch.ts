import dns from "node:dns";
import { isIP } from "node:net";
import { promisify } from "node:util";
import { runWithProxyContext } from "@omniroute/open-sse/utils/proxyFetch.ts";
import { FetchTimeoutError, fetchWithTimeout } from "@/shared/utils/fetchTimeout";
import {
  OutboundUrlGuardError,
  type OutboundUrlGuardMode,
  isPrivateHost,
  parseAndValidatePublicUrl,
  parseOutboundUrl,
} from "@/shared/network/outboundUrlGuard";

const dnsLookup = promisify(dns.lookup);

export type ValidateOutboundUrlGuard = "public-only" | "any";

export type ValidateOutboundUrlResult = { ok: true } | { ok: false; reason: string };

/**
 * Check whether an IPv4 string falls into a blocked range (loopback, private,
 * link-local, IMDS, reserved, broadcast).
 */
function isBlockedIpv4(ip: string): { blocked: boolean; reason?: string } {
  const octets = ip.split(".").map((segment) => parseInt(segment, 10));
  if (octets.length !== 4 || octets.some((o) => Number.isNaN(o))) {
    return { blocked: true, reason: "invalid_ipv4" };
  }
  const [a, b] = octets;

  // AWS IMDS — explicit before generic link-local
  if (ip === "169.254.169.254") return { blocked: true, reason: "aws_imds" };
  // Loopback 127/8
  if (a === 127) return { blocked: true, reason: "loopback" };
  // Reserved 0/8
  if (a === 0) return { blocked: true, reason: "reserved_zero" };
  // Private 10/8
  if (a === 10) return { blocked: true, reason: "private_10_8" };
  // Private 172.16/12
  if (a === 172 && b >= 16 && b <= 31) return { blocked: true, reason: "private_172_16" };
  // Private 192.168/16
  if (a === 192 && b === 168) return { blocked: true, reason: "private_192_168" };
  // Link-local 169.254/16
  if (a === 169 && b === 254) return { blocked: true, reason: "link_local" };
  // Carrier-grade NAT 100.64/10
  if (a === 100 && b >= 64 && b <= 127) return { blocked: true, reason: "carrier_grade_nat" };
  // Broadcast
  if (ip === "255.255.255.255") return { blocked: true, reason: "broadcast" };

  return { blocked: false };
}

/**
 * Check whether an IPv6 string falls into a blocked range (loopback,
 * link-local, ULA, IMDS, unspecified).
 */
function isBlockedIpv6(ip: string): { blocked: boolean; reason?: string } {
  const normalized = ip.toLowerCase();

  // Loopback
  if (normalized === "::1") return { blocked: true, reason: "loopback" };
  // Unspecified
  if (normalized === "::" || normalized === "::0") {
    return { blocked: true, reason: "unspecified" };
  }
  // AWS IMDS over IPv6
  if (normalized === "fd00:ec2::254") return { blocked: true, reason: "aws_imds" };

  // IPv4-mapped IPv6: ::ffff:a.b.c.d — defer to IPv4 check
  const v4MappedMatch = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4MappedMatch) {
    return isBlockedIpv4(v4MappedMatch[1]);
  }
  if (normalized.startsWith("::ffff:")) return { blocked: true, reason: "ipv4_mapped" };

  // Link-local fe80::/10
  if (
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  ) {
    return { blocked: true, reason: "link_local" };
  }

  // Unique-local fc00::/7 (fc.. or fd..)
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) {
    return { blocked: true, reason: "unique_local" };
  }

  return { blocked: false };
}

/**
 * Validate that an outbound URL is safe to fetch.
 *
 * In "public-only" mode, performs DNS lookup of the hostname (resolving to ALL
 * addresses) and rejects if any address falls into a blocked range — loopback,
 * link-local, private, AWS IMDS, reserved, etc. This is the SSRF-hardening path
 * used by webhook delivery, the favicon proxy, and provider-node creation.
 *
 * In "any" mode, only the URL syntax / protocol is checked.
 */
export async function validateOutboundUrl(
  url: string,
  guard: ValidateOutboundUrlGuard
): Promise<ValidateOutboundUrlResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "invalid_protocol" };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, reason: "embedded_credentials" };
  }

  if (guard === "any") {
    return { ok: true };
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!hostname) {
    return { ok: false, reason: "missing_hostname" };
  }

  // Fast-path string check (catches localhost, hostname-form private addresses)
  if (isPrivateHost(hostname)) {
    return { ok: false, reason: "private_hostname" };
  }

  // If the hostname is already a literal IP, check it directly
  const family = isIP(hostname);
  if (family === 4) {
    const result = isBlockedIpv4(hostname);
    return result.blocked ? { ok: false, reason: result.reason || "blocked_ipv4" } : { ok: true };
  }
  if (family === 6) {
    const result = isBlockedIpv6(hostname);
    return result.blocked ? { ok: false, reason: result.reason || "blocked_ipv6" } : { ok: true };
  }

  // DNS resolution — reject if ANY resolved address is blocked
  let addresses: { address: string; family: number }[];
  try {
    addresses = await dnsLookup(hostname, { all: true });
  } catch {
    return { ok: false, reason: "dns_resolution_failed" };
  }

  if (!addresses || addresses.length === 0) {
    return { ok: false, reason: "no_dns_records" };
  }

  for (const { address, family: fam } of addresses) {
    if (fam === 4) {
      const result = isBlockedIpv4(address);
      if (result.blocked) {
        return { ok: false, reason: result.reason || "blocked_ipv4" };
      }
    } else if (fam === 6) {
      const result = isBlockedIpv6(address);
      if (result.blocked) {
        return { ok: false, reason: result.reason || "blocked_ipv6" };
      }
    }
  }

  return { ok: true };
}

const DEFAULT_IDEMPOTENT_METHODS = ["GET", "HEAD", "OPTIONS", "PUT", "DELETE"];

export type SafeOutboundFetchGuard = OutboundUrlGuardMode;
export type SafeOutboundFetchErrorCode =
  | "INVALID_URL"
  | "URL_GUARD_BLOCKED"
  | "TIMEOUT"
  | "REDIRECT_BLOCKED"
  | "NETWORK_ERROR";

export interface SafeOutboundFetchRetryOptions {
  attempts?: number;
  backoffMs?: number | number[];
  methods?: string[];
  statusCodes?: number[];
}

export interface SafeOutboundFetchOptions extends RequestInit {
  timeoutMs?: number;
  allowRedirect?: boolean;
  retry?: SafeOutboundFetchRetryOptions | false;
  guard?: SafeOutboundFetchGuard;
  proxyConfig?: unknown;
}

type SafeOutboundFetchPresetMap = {
  validationRead: SafeOutboundFetchOptions;
  validationWrite: SafeOutboundFetchOptions;
  modelsProbe: SafeOutboundFetchOptions;
  modelsDiscovery: SafeOutboundFetchOptions;
  modelsPagination: SafeOutboundFetchOptions;
};

export const SAFE_OUTBOUND_FETCH_PRESETS: SafeOutboundFetchPresetMap = {
  validationRead: {
    timeoutMs: 5000,
    allowRedirect: false,
    retry: {
      attempts: 2,
      backoffMs: [150],
      methods: ["GET", "HEAD"],
    },
  },
  validationWrite: {
    timeoutMs: 7000,
    allowRedirect: false,
    retry: false,
  },
  modelsProbe: {
    timeoutMs: 5000,
    allowRedirect: false,
    retry: {
      attempts: 2,
      backoffMs: [150],
      methods: ["GET", "HEAD"],
    },
  },
  modelsDiscovery: {
    timeoutMs: 10000,
    allowRedirect: false,
    retry: {
      attempts: 2,
      backoffMs: [200],
      methods: ["GET", "HEAD"],
    },
  },
  modelsPagination: {
    timeoutMs: 15000,
    allowRedirect: false,
    retry: {
      attempts: 2,
      backoffMs: [250],
      methods: ["GET", "HEAD"],
    },
  },
};

type SafeOutboundFetchErrorInit = {
  code: SafeOutboundFetchErrorCode;
  url: string;
  method: string;
  attempts: number;
  isRetryable: boolean;
  timeoutMs?: number;
  status?: number;
  location?: string | null;
  cause?: unknown;
};

export class SafeOutboundFetchError extends Error {
  code: SafeOutboundFetchErrorCode;
  url: string;
  method: string;
  attempts: number;
  isRetryable: boolean;
  timeoutMs?: number;
  status?: number;
  location?: string | null;

  constructor(message: string, init: SafeOutboundFetchErrorInit) {
    super(message);
    this.name = "SafeOutboundFetchError";
    this.code = init.code;
    this.url = init.url;
    this.method = init.method;
    this.attempts = init.attempts;
    this.isRetryable = init.isRetryable;
    this.timeoutMs = init.timeoutMs;
    this.status = init.status;
    this.location = init.location ?? null;
    if (init.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = init.cause;
    }
  }
}

function normalizeMethod(method?: string) {
  return (method || "GET").toUpperCase();
}

function normalizeUrl(input: string | URL) {
  try {
    return parseOutboundUrl(input);
  } catch (error) {
    if (error instanceof OutboundUrlGuardError) {
      throw new SafeOutboundFetchError(error.message, {
        code: error.code === "OUTBOUND_URL_INVALID" ? "INVALID_URL" : "URL_GUARD_BLOCKED",
        url: error.url,
        method: "GET",
        attempts: 1,
        isRetryable: false,
        cause: error,
      });
    }
    throw new SafeOutboundFetchError(`Invalid outbound URL: ${String(input)}`, {
      code: "INVALID_URL",
      url: String(input),
      method: "GET",
      attempts: 1,
      isRetryable: false,
      cause: error,
    });
  }
}

function applyUrlGuard(targetUrl: URL, guard: SafeOutboundFetchGuard, method: string) {
  if (guard !== "public-only") return;

  try {
    parseAndValidatePublicUrl(targetUrl);
  } catch (error) {
    if (error instanceof OutboundUrlGuardError) {
      throw new SafeOutboundFetchError(error.message, {
        code: error.code === "OUTBOUND_URL_INVALID" ? "INVALID_URL" : "URL_GUARD_BLOCKED",
        url: error.url,
        method,
        attempts: 1,
        isRetryable: false,
        cause: error,
      });
    }
    throw error;
  }
}

function getRetryConfig(retry: SafeOutboundFetchRetryOptions | false | undefined, method: string) {
  if (retry === false) {
    return {
      attempts: 1,
      shouldRetryMethod: false,
      statusCodes: new Set<number>(),
      backoffMs: [] as number[],
    };
  }

  const methods = new Set(
    (retry?.methods || DEFAULT_IDEMPOTENT_METHODS).map((value) => value.toUpperCase())
  );
  const attempts = Math.max(1, retry?.attempts || 1);
  const backoffMs = Array.isArray(retry?.backoffMs)
    ? retry?.backoffMs
    : typeof retry?.backoffMs === "number"
      ? [retry.backoffMs]
      : [];
  const statusCodes = new Set(retry?.statusCodes || []);

  return {
    attempts,
    shouldRetryMethod: methods.has(method),
    statusCodes,
    backoffMs,
  };
}

function getBackoffDelay(backoffMs: number[], attemptNumber: number) {
  if (backoffMs.length === 0) return 0;
  return backoffMs[Math.min(attemptNumber - 1, backoffMs.length - 1)] || 0;
}

function sleep(ms: number) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cancelResponseBody(response: Response) {
  try {
    await response.body?.cancel();
  } catch {
    // Ignore body cancellation errors when preparing a retry.
  }
}

function normalizeFetchFailure(
  error: unknown,
  targetUrl: string,
  method: string,
  attempts: number
): SafeOutboundFetchError {
  if (error instanceof SafeOutboundFetchError) {
    error.attempts = attempts;
    return error;
  }

  if (error instanceof FetchTimeoutError) {
    return new SafeOutboundFetchError(error.message, {
      code: "TIMEOUT",
      url: targetUrl,
      method,
      attempts,
      timeoutMs: error.timeoutMs,
      isRetryable: true,
      cause: error,
    });
  }

  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === "object" ? (error as { code?: string }).code : undefined;

  return new SafeOutboundFetchError(message || `Outbound request failed for ${targetUrl}`, {
    code: "NETWORK_ERROR",
    url: targetUrl,
    method,
    attempts,
    isRetryable: code !== "PROXY_UNREACHABLE",
    cause: error,
  });
}

export async function safeOutboundFetch(url: string | URL, options: SafeOutboundFetchOptions = {}) {
  const targetUrl = normalizeUrl(url);
  const method = normalizeMethod(options.method);
  const {
    timeoutMs,
    allowRedirect = false,
    retry,
    guard = "none",
    proxyConfig,
    signal,
    ...fetchOptions
  } = options;

  applyUrlGuard(targetUrl, guard, method);

  const retryConfig = getRetryConfig(retry, method);
  const redirect = allowRedirect ? (fetchOptions.redirect ?? "follow") : "manual";

  for (let attempt = 1; attempt <= retryConfig.attempts; attempt++) {
    try {
      const executeFetch = () =>
        fetchWithTimeout(targetUrl.toString(), {
          ...fetchOptions,
          method,
          redirect,
          signal,
          timeoutMs,
        });

      const response = proxyConfig
        ? await runWithProxyContext(proxyConfig, executeFetch)
        : await executeFetch();

      if (!allowRedirect && response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await cancelResponseBody(response);
        throw new SafeOutboundFetchError(
          `Redirect blocked for ${method} ${targetUrl.toString()} (${response.status})`,
          {
            code: "REDIRECT_BLOCKED",
            url: targetUrl.toString(),
            method,
            attempts: attempt,
            status: response.status,
            location,
            isRetryable: false,
          }
        );
      }

      if (
        retryConfig.shouldRetryMethod &&
        attempt < retryConfig.attempts &&
        retryConfig.statusCodes.has(response.status)
      ) {
        await cancelResponseBody(response);
        await sleep(getBackoffDelay(retryConfig.backoffMs, attempt));
        continue;
      }

      return response;
    } catch (error) {
      const normalizedError = normalizeFetchFailure(error, targetUrl.toString(), method, attempt);
      const shouldRetry =
        retryConfig.shouldRetryMethod &&
        attempt < retryConfig.attempts &&
        normalizedError.isRetryable;

      if (!shouldRetry) {
        throw normalizedError;
      }

      await sleep(getBackoffDelay(retryConfig.backoffMs, attempt));
    }
  }

  throw new SafeOutboundFetchError(`Outbound request failed for ${targetUrl.toString()}`, {
    code: "NETWORK_ERROR",
    url: targetUrl.toString(),
    method,
    attempts: retryConfig.attempts,
    isRetryable: false,
  });
}

export function getSafeOutboundFetchErrorStatus(error: unknown) {
  if (!(error instanceof SafeOutboundFetchError)) return null;

  if (error.code === "TIMEOUT") return 504;
  if (
    error.code === "INVALID_URL" ||
    error.code === "URL_GUARD_BLOCKED" ||
    error.code === "REDIRECT_BLOCKED"
  ) {
    return 503;
  }

  return null;
}
