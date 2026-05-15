/**
 * Prompt Injection Guard — Express/Next.js middleware
 *
 * Legacy middleware facade that now delegates to the guardrail system.
 *
 * @module middleware/promptInjectionGuard
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
  evaluatePromptInjection,
  type PromptInjectionGuardrailOptions,
} from "@/lib/guardrails/promptInjection";
import { resolveDisabledGuardrails } from "@/lib/guardrails/registry";

/**
 * Tranche B — B7 (Bug review item #9)
 *
 * Annotation that the injection guard makes visible to the downstream handler
 * without mutating the (immutable) `Request.headers`. The guard wraps the
 * handler invocation in `injectionContext.run(...)`; downstream code that
 * needs to know whether the request was flagged calls
 * `getInjectionAnnotation()`.
 *
 * Replaces the previous broken side-channel where the guard called
 * `request.headers.set("X-Injection-Flagged", ...)` — that throws on
 * undici's immutable Request.headers (silently swallowed by the try/catch),
 * so downstream consumers never observed the flag.
 */
export interface InjectionAnnotation {
  flagged: boolean;
  detections: number;
}

const injectionContext = new AsyncLocalStorage<InjectionAnnotation>();

/**
 * Read the injection annotation attached by `withInjectionGuard` for the
 * current async context. Returns `undefined` outside the guard's scope.
 */
export function getInjectionAnnotation(): InjectionAnnotation | undefined {
  return injectionContext.getStore();
}

/**
 * Create a prompt injection guard middleware.
 *
 * @param {PromptInjectionGuardrailOptions} [options={}]
 * @returns {(req: Request) => { blocked: boolean, result: Object }|null}
 */
export function createInjectionGuard(options: PromptInjectionGuardrailOptions = {}) {
  /**
   * Check a request body for prompt injection.
   *
   * @param {Object} body - The parsed request body
   * @returns {{ blocked: boolean, result: Object }}
   */
  return function guardRequest(body: any) {
    if (!body || typeof body !== "object") {
      return { blocked: false, result: { flagged: false, detections: [], piiDetections: [] } };
    }

    const decision = evaluatePromptInjection(body, options, {
      disabledGuardrails: resolveDisabledGuardrails({ body }),
      log: options.logger || console,
    });
    return {
      blocked: decision.blocked,
      result: decision.result,
    };
  };
}

/**
 * Next.js API route handler wrapper for injection guarding.
 *
 * Tranche B fixes embedded here:
 *   - B7 (#9): annotate the request via AsyncLocalStorage instead of mutating
 *     the immutable `Request.headers`. Downstream handlers that previously
 *     never saw the flag (the writes silently threw) can now call
 *     `getInjectionAnnotation()`.
 *   - B8 (#10): fail OPEN when the evaluator itself throws. AGENTS.md and
 *     `docs/security/GUARDRAILS.md` both mandate fail-open for guardrails;
 *     the previous 500 response let any bug in the evaluator brick every
 *     mutating route for all clients.
 *
 * @param {Function} handler - Original route handler
 * @param {GuardOptions} [options={}]
 * @returns {Function} Wrapped handler
 */
export function withInjectionGuard(handler: any, options: any = {}) {
  const guard = createInjectionGuard(options);

  return async function guardedHandler(request: any, context: any) {
    // Only apply to POST/PUT/PATCH
    if (!["POST", "PUT", "PATCH"].includes(request.method)) {
      return handler(request, context);
    }

    let annotation: InjectionAnnotation = { flagged: false, detections: 0 };

    try {
      // Clone request so body can still be read by handler
      const cloned = request.clone();
      const body = await cloned.json().catch(() => null);

      if (body) {
        const { blocked, result }: any = guard(body);

        if (blocked) {
          return new Response(
            JSON.stringify({
              error: {
                message: "Request blocked: potential prompt injection detected",
                type: "injection_detected",
                detections: result.detections.length,
              },
            }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        }

        // Annotate the async context so downstream handlers can opt-in via
        // getInjectionAnnotation() without depending on header mutation.
        if (result.flagged) {
          annotation = { flagged: true, detections: result.detections.length };
        }
      }
    } catch (error) {
      // B8 (#10): fail-open — log and continue to the handler. A bug in the
      // evaluator must not take down the whole route.
      console.error("[SECURITY] Injection guard error (fail-open):", error);
    }

    return injectionContext.run(annotation, () => handler(request, context));
  };
}
