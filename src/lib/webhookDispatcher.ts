/**
 * Webhook Dispatcher
 * Dispatches events to registered webhooks with HMAC-SHA256 signing and retries
 */

import crypto from "crypto";
import {
  SafeOutboundFetchError,
  safeOutboundFetch,
  validateOutboundUrl,
} from "@/shared/network/safeOutboundFetch";

export type WebhookEvent =
  | "request.completed"
  | "request.failed"
  | "provider.error"
  | "provider.recovered"
  | "quota.exceeded"
  | "combo.switched"
  | "test.ping";

export interface WebhookPayload {
  event: WebhookEvent;
  timestamp: string;
  data: Record<string, any>;
}

function signPayload(payload: string, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(payload).digest("hex")}`;
}

export async function deliverWebhook(
  url: string,
  payload: WebhookPayload,
  secret?: string | null,
  maxRetries = 3
): Promise<{ success: boolean; status: number; error?: string }> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "OmniRoute-Webhook/1.0",
    "X-Webhook-Event": payload.event,
    "X-Webhook-Timestamp": payload.timestamp,
  };

  if (secret) {
    headers["X-Webhook-Signature"] = signPayload(body, secret);
  }

  // SSRF guard — resolve DNS and reject private/loopback/IMDS targets up front.
  const urlCheck = await validateOutboundUrl(url, "public-only");
  if (!urlCheck.ok) {
    return {
      success: false,
      status: 400,
      error: `blocked_target: ${urlCheck.reason}`,
    };
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await safeOutboundFetch(url, {
        method: "POST",
        headers,
        body,
        guard: "public-only",
        timeoutMs: 10000,
        retry: false,
      });

      if (res.ok || res.status < 500) {
        return { success: res.ok, status: res.status };
      }

      // Server error — retry with exponential backoff
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
      }
    } catch (error: any) {
      if (error instanceof SafeOutboundFetchError && error.code === "URL_GUARD_BLOCKED") {
        return { success: false, status: 400, error: "blocked_target" };
      }
      if (attempt === maxRetries) {
        return { success: false, status: 0, error: error.message || "Network error" };
      }
      await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
    }
  }

  return { success: false, status: 0, error: "Max retries exceeded" };
}

/**
 * Dispatch an event to all matching enabled webhooks
 */
export async function dispatchEvent(event: WebhookEvent, data: Record<string, any>): Promise<void> {
  // Lazy import to avoid circular deps
  const { getEnabledWebhooks, recordWebhookDelivery, disableWebhooksWithHighFailures } =
    await import("./db/webhooks");

  const webhooks = getEnabledWebhooks();
  const payload: WebhookPayload = {
    event,
    timestamp: new Date().toISOString(),
    data,
  };

  const deliveries = webhooks
    .filter((wh) => {
      const events = wh.events;
      return events.includes("*") || events.includes(event);
    })
    .map(async (wh) => {
      const result = await deliverWebhook(wh.url, payload, wh.secret);
      recordWebhookDelivery(wh.id, result.status, result.success);
      return { webhookId: wh.id, ...result };
    });

  await Promise.allSettled(deliveries);

  // Auto-disable webhooks with too many failures
  disableWebhooksWithHighFailures(10);
}
