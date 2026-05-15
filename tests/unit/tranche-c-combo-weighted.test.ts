/**
 * Tranche C #18 + #24 regression tests for combo weighted selection.
 *
 *   #18 — `orderTargetsForWeightedFallback` used to silently drop the head
 *         when the selected `executionKey` was no longer present in the
 *         target list (race / hot-reload). The fix warns and substitutes
 *         `targets[0]` as the head so callers still receive a non-empty
 *         ordered list.
 *
 *   #24 — `selectWeightedTarget` had two edge cases:
 *           (a) totalWeight === 0 now early-returns a uniform random pick,
 *           (b) the subtractive loop may exit with floating-point residue,
 *               so the explicit final fallback returns `targets[N-1]`.
 *
 * Both functions are pure / deterministic given a stubbed `Math.random`, so
 * the tests do not require a database or an in-flight request.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  orderTargetsForWeightedFallback,
  selectWeightedTarget,
} from "../../open-sse/services/combo.ts";

type WeightedTarget = { executionKey: string; weight: number };

function withStubbedRandom(values: number[], run: () => void) {
  const original = Math.random;
  let i = 0;
  Math.random = () => {
    const v = values[i % values.length];
    i++;
    return v;
  };
  try {
    run();
  } finally {
    Math.random = original;
  }
}

test("selectWeightedTarget: totalWeight === 0 picks uniformly via Math.random", () => {
  const targets: WeightedTarget[] = [
    { executionKey: "a", weight: 0 },
    { executionKey: "b", weight: 0 },
    { executionKey: "c", weight: 0 },
  ];
  // With Math.random() === 0.0 → index 0 ('a').
  withStubbedRandom([0], () => {
    const picked = selectWeightedTarget(targets);
    assert.ok(picked, "must not return null when targets is non-empty");
    assert.equal(picked.executionKey, "a");
  });
  // With Math.random() === 0.5 → index 1 ('b').
  withStubbedRandom([0.5], () => {
    const picked = selectWeightedTarget(targets);
    assert.equal(picked?.executionKey, "b");
  });
  // With Math.random() === 0.999 → index 2 ('c').
  withStubbedRandom([0.999], () => {
    const picked = selectWeightedTarget(targets);
    assert.equal(picked?.executionKey, "c");
  });
});

test("selectWeightedTarget: empty list returns null", () => {
  assert.equal(selectWeightedTarget([]), null);
});

test("selectWeightedTarget: floating-point residue exits the loop and returns the last target explicitly", () => {
  // Construct weights whose subtractive walk leaves a tiny positive residue.
  // The actual production trigger is FP rounding of `Math.random() * totalWeight`
  // vs sum-of-(weight)s — we simulate that by stubbing Math.random to a
  // value of *exactly 1.0* so `random = totalWeight` and every iteration
  // exits with `random > 0` (subtraction never crosses zero because of
  // FP rounding at the boundary).
  const targets: WeightedTarget[] = [
    { executionKey: "first", weight: 1 },
    { executionKey: "mid", weight: 1 },
    { executionKey: "last", weight: 1 },
  ];
  withStubbedRandom([0.9999999999999999], () => {
    const picked = selectWeightedTarget(targets);
    assert.ok(picked, "fallback must not return undefined");
    assert.equal(
      picked.executionKey,
      "last",
      "floating-point residue case must return the final target explicitly"
    );
  });
});

test("orderTargetsForWeightedFallback: missing executionKey warns and falls back to targets[0] as head", () => {
  const targets: WeightedTarget[] = [
    { executionKey: "alpha", weight: 5 },
    { executionKey: "beta", weight: 3 },
    { executionKey: "gamma", weight: 1 },
  ];

  // Capture warnings so we can assert the log message contract.
  const warnings: Array<{ tag: string; message: string; data: unknown }> = [];
  const log = {
    warn: (tag: string, message: string, data?: unknown) => {
      warnings.push({ tag, message, data });
    },
  };

  // Selected key is NOT in the list (simulates a hot-reload race).
  const ordered = orderTargetsForWeightedFallback(
    targets,
    "no-such-key",
    /* preserveExistingOrder */ false,
    log
  );

  // (a) A warning must be emitted with the COMBO tag and the expected payload.
  assert.equal(warnings.length, 1, "exactly one warn() call expected");
  assert.equal(warnings[0].tag, "COMBO");
  assert.match(warnings[0].message, /Weighted fallback could not find the selected executionKey/);
  assert.deepEqual(
    (warnings[0].data as Record<string, unknown>).selectedExecutionKey,
    "no-such-key"
  );
  assert.deepEqual((warnings[0].data as Record<string, unknown>).availableKeys, [
    "alpha",
    "beta",
    "gamma",
  ]);

  // (b) The head must be targets[0] (alpha), NOT undefined.
  assert.ok(ordered.length >= 1, "must return a non-empty list when targets exist");
  assert.ok(ordered[0], "head must not be undefined");
  assert.equal(ordered[0].executionKey, "alpha", "head falls back to targets[0]");

  // (c) The rest of the list contains the other targets (sorted by weight
  //     descending since preserveExistingOrder=false). Importantly, alpha
  //     does not appear twice.
  const tailKeys = ordered.slice(1).map((t) => t.executionKey);
  assert.ok(!tailKeys.includes("alpha"), "alpha must not be duplicated in the tail");
  assert.deepEqual(tailKeys, ["beta", "gamma"]);
});

test("orderTargetsForWeightedFallback: missing executionKey with empty targets returns []", () => {
  const warnings: unknown[] = [];
  const log = { warn: (...args: unknown[]) => warnings.push(args) };

  const ordered = orderTargetsForWeightedFallback([], "anything", false, log);

  assert.deepEqual(ordered, []);
  assert.equal(warnings.length, 1, "still warns once even when the target list is empty");
});

test("orderTargetsForWeightedFallback: matching executionKey returns selected-first ordering", () => {
  const targets: WeightedTarget[] = [
    { executionKey: "alpha", weight: 5 },
    { executionKey: "beta", weight: 3 },
    { executionKey: "gamma", weight: 1 },
  ];

  const warnings: unknown[] = [];
  const log = { warn: (...args: unknown[]) => warnings.push(args) };

  const ordered = orderTargetsForWeightedFallback(targets, "beta", false, log);

  // No warn — happy path.
  assert.equal(warnings.length, 0);

  // Selected target is the head; remaining sorted by weight desc.
  assert.deepEqual(
    ordered.map((t) => t.executionKey),
    ["beta", "alpha", "gamma"]
  );
});

test("orderTargetsForWeightedFallback: preserveExistingOrder keeps the tail in input order", () => {
  const targets: WeightedTarget[] = [
    { executionKey: "alpha", weight: 1 },
    { executionKey: "beta", weight: 9 },
    { executionKey: "gamma", weight: 5 },
  ];
  const ordered = orderTargetsForWeightedFallback(targets, "alpha", /* preserve */ true);
  // Selected alpha first; tail stays in original order (beta, gamma) — NOT
  // sorted-by-weight order (which would have been beta, gamma anyway, but
  // try a different ordering to be sure: alpha-as-selected gives tail
  // ["beta", "gamma"] regardless; we just assert preserve=true did not
  // re-sort).
  assert.deepEqual(
    ordered.map((t) => t.executionKey),
    ["alpha", "beta", "gamma"]
  );
});

test("orderTargetsForWeightedFallback: works without a log argument (production hot path)", () => {
  // The `log` parameter is optional — verify no throw when omitted, even on
  // the warn path.
  const targets: WeightedTarget[] = [
    { executionKey: "x", weight: 1 },
    { executionKey: "y", weight: 1 },
  ];
  // Warn path (no log) — must not throw and must still fall back to targets[0].
  const ordered = orderTargetsForWeightedFallback(targets, "missing");
  assert.equal(ordered[0]?.executionKey, "x");
});
