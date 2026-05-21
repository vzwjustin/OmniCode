/**
 * Settings endpoint for the local-fusion orchestrator.
 *
 *   GET  /api/settings/fusion-config  → current active config (with defaults).
 *   PUT  /api/settings/fusion-config  → patch active config; returns the new value.
 *
 * Both require dashboard authentication. The fusion handler in
 * ``open-sse/handlers/fusion.ts`` consults the persisted value whenever a
 * chat request hits with model=local-fusion (or one of its variants).
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  getFusionConfig,
  setFusionConfig,
  resetFusionConfig,
  FUSION_CONFIG_DEFAULTS,
} from "@/lib/localDb";
import { isAuthenticated } from "@/shared/utils/apiAuth";
import { clearFusionCache } from "@omniroute/open-sse/handlers/fusion.ts";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

const fusionConfigUpdateSchema = z
  .object({
    analysisModels: z.array(z.string().min(1).max(256)).max(16).optional(),
    judgeModel: z.string().min(1).max(256).nullable().optional(),
    criticModel: z.string().min(1).max(256).nullable().optional(),
    mode: z.enum(["fast", "balanced", "deep", "code"]).optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().min(1).max(32_000).optional(),
    enableCritique: z.boolean().optional(),
    enableCache: z.boolean().optional(),
    cacheTtlSeconds: z
      .number()
      .int()
      .min(0)
      .max(24 * 60 * 60)
      .optional(),
    perModelTimeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(15 * 60 * 1000)
      .optional(),
    enabled: z.boolean().optional(),
    // ``reset: true`` clears the config back to defaults.
    reset: z.literal(true).optional(),
  })
  .strict();

export async function GET(request: NextRequest) {
  if (!(await isAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const active = getFusionConfig();
    return NextResponse.json({ active, defaults: FUSION_CONFIG_DEFAULTS });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest) {
  if (!(await isAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const validation = validateBody(fusionConfigUpdateSchema, rawBody);
  if (isValidationFailure(validation)) {
    return validation.response;
  }
  const body = validation.data;

  try {
    if (body.reset === true) {
      const reset = resetFusionConfig();
      clearFusionCache();
      return NextResponse.json({ active: reset, defaults: FUSION_CONFIG_DEFAULTS, reset: true });
    }

    const patch: Record<string, unknown> = {};
    if (body.analysisModels !== undefined) patch.analysisModels = body.analysisModels;
    if (body.judgeModel !== undefined) patch.judgeModel = body.judgeModel;
    if (body.criticModel !== undefined) patch.criticModel = body.criticModel;
    if (body.mode !== undefined) patch.mode = body.mode;
    if (body.temperature !== undefined) patch.temperature = body.temperature;
    if (body.maxTokens !== undefined) patch.maxTokens = body.maxTokens;
    if (body.enableCritique !== undefined) patch.enableCritique = body.enableCritique;
    if (body.enableCache !== undefined) patch.enableCache = body.enableCache;
    if (body.cacheTtlSeconds !== undefined) patch.cacheTtlSeconds = body.cacheTtlSeconds;
    if (body.perModelTimeoutMs !== undefined) patch.perModelTimeoutMs = body.perModelTimeoutMs;
    if (body.enabled !== undefined) patch.enabled = body.enabled;

    const updated = setFusionConfig(patch);
    // Cache is keyed by config — invalidate so the new settings take effect.
    clearFusionCache();

    return NextResponse.json({ active: updated, defaults: FUSION_CONFIG_DEFAULTS });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
