let __loopbackReadyPromise: Promise<void> | null = null;

export type EnsureReadyOptions = {
  fetch?: typeof fetch;
  maxWaitMs?: number;
  pollMs?: number;
};

export async function ensureLoopbackServerReady(opts: EnsureReadyOptions = {}): Promise<void> {
  if (__loopbackReadyPromise) return __loopbackReadyPromise;
  __loopbackReadyPromise = (async () => {
    const f = opts.fetch ?? fetch;
    const maxWaitMs = opts.maxWaitMs ?? 30_000;
    const pollMs = opts.pollMs ?? 250;
    const deadline = Date.now() + maxWaitMs;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      try {
        const probePort = process.env.OMNIROUTE_PORT || process.env.PORT || "20128";
        const res = await f(
          `http://127.0.0.1:${probePort}/api/providers/__readiness_probe__/models`,
          {
            signal: AbortSignal.timeout(2_000),
          }
        );
        if (res.status >= 200 && res.status < 600) return;
      } catch (err) {
        lastErr = err;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error(`loopback server not ready within ${maxWaitMs}ms: ${String(lastErr)}`);
  })();
  return __loopbackReadyPromise;
}

export function __resetLoopbackReadinessForTests(): void {
  __loopbackReadyPromise = null;
}

export type SelfFetchWithRetryOptions = {
  fetch?: typeof fetch;
  maxRetries?: number;
  backoffMs?: number;
  connectionId?: string;
  inProcessFallback?: () => Promise<Response>;
  skipReadinessGate?: boolean;
};

export async function selfFetchWithRetry(
  url: string,
  opts: SelfFetchWithRetryOptions = {}
): Promise<Response> {
  const f = opts.fetch ?? fetch;
  const maxRetries = opts.maxRetries ?? 3;
  const backoffMs = opts.backoffMs ?? 200;
  const connLabel = opts.connectionId ? opts.connectionId.slice(0, 8) : url.slice(-8);

  if (opts.skipReadinessGate !== true) {
    try {
      await ensureLoopbackServerReady({ fetch: f });
    } catch (err) {
      console.warn(
        `[ModelSync] Loopback server readiness probe failed; falling back to in-process route immediately (${connLabel}): ${String(err)}`
      );
      if (opts.inProcessFallback) {
        return opts.inProcessFallback();
      }
      return new Response(JSON.stringify({ error: "self-fetch unavailable" }), { status: 503 });
    }
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await f(url, { method: "GET" });
    } catch (err) {
      lastErr = err;
    }
    if (attempt < maxRetries - 1) {
      await new Promise<void>((r) => setTimeout(r, backoffMs * (attempt + 1)));
    }
  }

  console.warn(
    `[ModelSync] Internal /models self-fetch failed for ${connLabel} after ${maxRetries} attempt(s); falling back to in-process route (last err: ${String(lastErr)})`
  );

  if (opts.inProcessFallback) {
    return opts.inProcessFallback();
  }
  return new Response(JSON.stringify({ error: "self-fetch unavailable" }), { status: 503 });
}
