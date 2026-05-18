import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { rtkConfigSchema } from "../../../src/shared/validation/compressionConfigSchemas.ts";
import {
  assignmentsUpdateSchema,
  compressionComboCreateSchema,
  compressionComboUpdateSchema,
  rtkTestSchema,
} from "../../../src/server/compression/apiSchemas.ts";

describe("context compression API schemas", () => {
  it("rejects invalid RTK config and test payloads", () => {
    assert.equal(rtkConfigSchema.safeParse({ intensity: "extreme" }).success, false);
    assert.equal(rtkConfigSchema.safeParse({ applyToCodeBlocks: true }).success, true);
    assert.equal(
      rtkConfigSchema.safeParse({
        customFiltersEnabled: true,
        trustProjectFilters: false,
        rawOutputRetention: "failures",
        rawOutputMaxBytes: 4096,
      }).success,
      true
    );
    assert.equal(rtkConfigSchema.safeParse({ rawOutputRetention: "plaintext" }).success, false);
    assert.equal(rtkTestSchema.safeParse({ text: "" }).success, false);
    assert.equal(rtkTestSchema.safeParse({ text: "ok", extra: true }).success, false);
    assert.equal(
      rtkTestSchema.safeParse({
        text: "ok",
        config: { maxLinesPerResult: -1, madeUp: true },
      }).success,
      false
    );
  });

  it("rejects invalid compression combo payloads", () => {
    assert.equal(compressionComboCreateSchema.safeParse({ name: "" }).success, false);
    assert.equal(
      compressionComboCreateSchema.safeParse({
        name: "Stacked",
        pipeline: [{ engine: "rtk", intensity: "standard" }],
      }).success,
      true
    );
    assert.equal(compressionComboUpdateSchema.safeParse({ isDefault: true }).success, true);
    assert.equal(compressionComboUpdateSchema.safeParse({ pipeline: [] }).success, false);
    assert.equal(assignmentsUpdateSchema.safeParse({ routingComboIds: ["combo-a"] }).success, true);
    assert.equal(assignmentsUpdateSchema.safeParse({ routingComboIds: [""] }).success, false);
    assert.equal(
      compressionComboCreateSchema.safeParse({
        name: "Bad",
        pipeline: [{ engine: "rtk", intensity: "bogus" }],
      }).success,
      false
    );
  });
});
