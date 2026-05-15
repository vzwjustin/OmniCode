import { trackPendingRequest } from "@/lib/usageDb";

// Stream handler with disconnect detection - shared for all providers

const PENDING_REQUEST_CLEARED_MARKER = "__omniroutePendingRequestCleared";
const DISCONNECT_ABORT_DELAY_MS = 2_000;

type StreamDisconnectEvent = {
  reason: string;
  duration: number;
};

type StreamControllerOptions = {
  onDisconnect?: (event: StreamDisconnectEvent) => void;
  log?: unknown;
  provider?: string;
  model?: string;
  connectionId?: string | null;
};

type StreamController = ReturnType<typeof createStreamController>;

// Get HH:MM:SS timestamp
function getTimeString() {
  return new Date().toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * Create stream controller with abort and disconnect detection
 * @param {object} options
 * @param {function} options.onDisconnect - Callback when client disconnects
 * @param {object} options.log - Logger instance
 * @param {string} options.provider - Provider name
 * @param {string} options.model - Model name
 */
/** @param {StreamControllerOptions} options */
export function createStreamController({
  onDisconnect,
  log,
  provider,
  model,
  connectionId,
}: StreamControllerOptions = {}) {
  const abortController = new AbortController();
  const startTime = Date.now();
  let disconnected = false;
  let abortTimeout: ReturnType<typeof setTimeout> | null = null;
  let pendingRequestCleared = false;

  const logStream = (status) => {
    const duration = Date.now() - startTime;
    const p = provider?.toUpperCase() || "UNKNOWN";
    console.log(
      `[${getTimeString()}] 🌊 [STREAM] ${p} | ${model || "unknown"} | ${duration}ms | ${status}`
    );
  };

  const clearPendingRequest = (error?: unknown) => {
    if (pendingRequestCleared) return;
    if (
      error &&
      typeof error === "object" &&
      (error as Record<string, unknown>)[PENDING_REQUEST_CLEARED_MARKER] === true
    ) {
      pendingRequestCleared = true;
      return;
    }

    pendingRequestCleared = true;
    if (!model && !provider && !connectionId) return;
    try {
      trackPendingRequest(model || "", provider || "", connectionId ?? null, false);
    } catch {}
  };

  return {
    signal: abortController.signal,
    startTime,

    isConnected: () => !disconnected,

    // Call when client disconnects
    handleDisconnect: (reason = "client_closed") => {
      if (disconnected) return;
      disconnected = true;

      logStream(`disconnect: ${reason}`);

      // Decrement pending request counter — the TransformStream flush() won't
      // fire when the client aborts mid-stream, so we must clean up here.
      clearPendingRequest();

      // Delay abort to allow cleanup
      abortTimeout = setTimeout(() => {
        abortController.abort();
      }, DISCONNECT_ABORT_DELAY_MS);

      onDisconnect?.({ reason, duration: Date.now() - startTime });
    },

    // Call when stream completes normally
    handleComplete: () => {
      // Always clear any pending abort timer first - even if we already
      // marked the stream disconnected (e.g. handleDisconnect fired and
      // then completion arrived inside the DISCONNECT_ABORT_DELAY_MS
      // window). Without this clear, the orphan setTimeout would still
      // call abortController.abort() ~2s later, racing with downstream
      // consumers that have already finished cleanly.
      if (abortTimeout) {
        clearTimeout(abortTimeout);
        abortTimeout = null;
      }

      if (disconnected) return;
      disconnected = true;

      logStream("complete");
    },

    // Call on error
    handleError: (error: unknown) => {
      if (abortTimeout) {
        clearTimeout(abortTimeout);
        abortTimeout = null;
      }

      clearPendingRequest(error);

      if (error instanceof Error && error.name === "AbortError") {
        logStream("aborted");
        return;
      }

      if (error instanceof Error) {
        logStream(`error: ${error.message}`);
        return;
      }
      logStream("error: unknown");
    },

    abort: () => abortController.abort(),
  };
}

/**
 * Create transform stream with disconnect detection
 * Wraps existing transform stream and adds abort capability.
 *
 * `transformStream.writable` is optional — callers that have already piped
 * the upstream through the transform (e.g. `pipeWithDisconnect`) only have a
 * `ReadableStream` to surface to the client, so we skip the writer abort in
 * that case. Callers that still own both sides of a `TransformStream` pass
 * the full object and we abort the writer on cancel for correct cleanup.
 */
export function createDisconnectAwareStream(transformStream, streamController) {
  const reader = transformStream.readable.getReader();
  const writer =
    transformStream.writable && typeof transformStream.writable.getWriter === "function"
      ? transformStream.writable.getWriter()
      : null;

  return new ReadableStream({
    async pull(controller) {
      if (!streamController.isConnected()) {
        controller.close();
        return;
      }

      try {
        const { done, value } = await reader.read();
        if (done) {
          streamController.handleComplete();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        streamController.handleError(error);

        // T35: Encapsulate mid-stream errors as SSE events instead of abruptly aborting
        // This prevents TransferEncodingError on the client side
        const errorMsg = error instanceof Error ? error.message : "Upstream stream error";
        const statusCode =
          typeof error === "object" && error !== null && "statusCode" in error
            ? Number((error as { statusCode?: unknown }).statusCode) || 500
            : 500;

        const errorEvent = {
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "error",
            },
          ],
          error: {
            message: errorMsg,
            type: "upstream_error",
            code: statusCode,
          },
        };

        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorEvent)}\n\n`));
        controller.enqueue(encoder.encode(`data: [DONE]\n\n`));

        controller.close();
      }
    },

    cancel(reason) {
      streamController.handleDisconnect(reason || "cancelled");
      reader.cancel();
      if (writer) {
        setTimeout(() => {
          writer.abort();
        }, DISCONNECT_ABORT_DELAY_MS).unref?.();
      }
    },
  });
}

/**
 * Pipe provider response through transform with disconnect detection
 * @param {Response} providerResponse - Response from provider
 * @param {TransformStream} transformStream - Transform stream for SSE
 * @param {object} streamController - Stream controller from createStreamController
 */
export function pipeWithDisconnect(
  providerResponse: Response,
  transformStream: TransformStream<Uint8Array, Uint8Array>,
  streamController: StreamController
) {
  const transformedBody = providerResponse.body.pipeThrough(transformStream);
  // The transform's writable side is already owned by `pipeThrough`, so we pass
  // only the readable half. `createDisconnectAwareStream` handles the missing
  // writable by skipping the writer abort on cancel — `reader.cancel()` is what
  // actually propagates the disconnect upstream in this flow.
  return createDisconnectAwareStream({ readable: transformedBody }, streamController);
}
