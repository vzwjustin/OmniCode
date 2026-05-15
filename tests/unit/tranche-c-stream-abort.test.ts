/**
 * Tranche C bonus regressions for stream handler and merged abort signals.
 *
 *   C11 (#11) createStreamController: when handleComplete() runs after
 *             handleDisconnect() (inside the DISCONNECT_ABORT_DELAY_MS
 *             window), the pending abort timer must be cleared. Previously
 *             the early-return on `disconnected` short-circuited past the
 *             clearTimeout(), so the orphan setTimeout still called
 *             abortController.abort() ~2s later.
 *
 *   C19 (#19) mergeAbortSignals: when one of the two input signals fires,
 *             its listener is removed via {once:true}, but the OTHER
 *             signal's listener used to stay subscribed forever, leaking
 *             listeners on long-lived request-level signals. The fix tears
 *             down the surviving listener when its sibling resolves the
 *             merge.
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { getEventListeners } from "node:events";

import { createStreamController } from "../../open-sse/utils/streamHandler.ts";
import { mergeAbortSignals } from "../../open-sse/executors/base.ts";

describe("Tranche C bonus — C11: streamHandler clears abort timer on late completion", () => {
  it("does not abort the controller when handleComplete fires after handleDisconnect", async () => {
    const controller = createStreamController({ provider: "test", model: "test-model" });

    // Simulate the production race: client disconnects, then the upstream
    // stream finishes cleanly within the 2s grace window.
    controller.handleDisconnect("client_closed");
    assert.equal(controller.signal.aborted, false, "signal must not be aborted immediately");

    // The fix: handleComplete clears the pending abort timer even if
    // `disconnected` is already true.
    controller.handleComplete();

    // Wait beyond the DISCONNECT_ABORT_DELAY_MS (2s) to prove the timer
    // really was cleared and didn't just fire late.
    await new Promise((r) => setTimeout(r, 2_100));

    assert.equal(
      controller.signal.aborted,
      false,
      "abort timer must be cleared by handleComplete; the controller must not abort"
    );
  });

  it("still aborts when handleDisconnect fires with no subsequent completion", async () => {
    const controller = createStreamController({ provider: "test", model: "test-model" });
    controller.handleDisconnect("client_closed");
    await new Promise((r) => setTimeout(r, 2_100));
    assert.equal(
      controller.signal.aborted,
      true,
      "without a completion, the disconnect timer still aborts the controller"
    );
  });
});

describe("Tranche C bonus — C19: mergeAbortSignals removes the surviving listener", () => {
  function listenerCount(signal: AbortSignal): number {
    return (getEventListeners(signal, "abort") || []).length;
  }

  it("removes the listener from the non-firing signal when the firing signal aborts", () => {
    const primary = new AbortController();
    const secondary = new AbortController();

    const before = listenerCount(secondary.signal);
    const merged = mergeAbortSignals(primary.signal, secondary.signal);
    assert.equal(merged.aborted, false);

    const afterRegister = listenerCount(secondary.signal);
    assert.ok(
      afterRegister > before,
      "mergeAbortSignals should register a listener on the secondary signal"
    );

    // Fire the primary; the merged signal should abort AND the secondary's
    // listener should be torn down.
    primary.abort(new Error("primary aborted"));
    assert.equal(merged.aborted, true);

    const afterPrimaryFires = listenerCount(secondary.signal);
    assert.equal(
      afterPrimaryFires,
      before,
      "secondary signal must have zero residual listeners after primary fires"
    );
  });

  it("removes the listener from the primary signal when the secondary signal aborts", () => {
    const primary = new AbortController();
    const secondary = new AbortController();

    const before = listenerCount(primary.signal);
    const merged = mergeAbortSignals(primary.signal, secondary.signal);
    assert.equal(merged.aborted, false);

    const afterRegister = listenerCount(primary.signal);
    assert.ok(
      afterRegister > before,
      "mergeAbortSignals should register a listener on the primary signal"
    );

    secondary.abort(new Error("secondary aborted"));
    assert.equal(merged.aborted, true);

    const afterSecondaryFires = listenerCount(primary.signal);
    assert.equal(
      afterSecondaryFires,
      before,
      "primary signal must have zero residual listeners after secondary fires"
    );
  });

  it("short-circuits when primary is already aborted (no listeners registered)", () => {
    const primary = new AbortController();
    const secondary = new AbortController();
    primary.abort(new Error("pre-aborted"));

    const beforeSecondary = listenerCount(secondary.signal);
    const merged = mergeAbortSignals(primary.signal, secondary.signal);

    assert.equal(merged.aborted, true);
    const afterSecondary = listenerCount(secondary.signal);
    assert.equal(
      afterSecondary,
      beforeSecondary,
      "no listener should be registered on secondary when primary is already aborted"
    );
  });
});
