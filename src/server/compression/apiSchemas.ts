import { z } from "zod";
import {
  cavemanIntensitySchema,
  compressionPreviewConfigSchema,
  rtkConfigSchema,
  stackedPipelineStepSchema,
} from "@/shared/validation/compressionConfigSchemas";

export const PreviewCompressionConfigSchema = compressionPreviewConfigSchema;

export const PreviewRequestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.string(),
        content: z.union([z.string(), z.array(z.unknown())]),
      })
    )
    .min(1),
  mode: z.enum(["off", "lite", "standard", "aggressive", "ultra", "rtk", "stacked"]),
  config: PreviewCompressionConfigSchema.optional(),
});

export const pipelineStepSchema = stackedPipelineStepSchema;

export const compressionComboCreateSchema = z
  .object({
    id: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1).max(120),
    description: z.string().max(1000).optional(),
    pipeline: z.array(pipelineStepSchema).min(1).optional(),
    languagePacks: z.array(z.string().trim().min(1)).optional(),
    outputMode: z.boolean().optional(),
    outputModeIntensity: cavemanIntensitySchema.optional(),
    isDefault: z.boolean().optional(),
  })
  .strict();

export const compressionComboUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().max(1000).optional(),
    pipeline: z.array(pipelineStepSchema).min(1).optional(),
    languagePacks: z.array(z.string().trim().min(1)).optional(),
    outputMode: z.boolean().optional(),
    outputModeIntensity: cavemanIntensitySchema.optional(),
    isDefault: z.boolean().optional(),
  })
  .strict();

export const assignmentsUpdateSchema = z
  .object({
    routingComboIds: z.array(z.string().trim().min(1)),
  })
  .strict();

export const rtkTestSchema = z
  .object({
    text: z.string().min(1),
    command: z.string().optional(),
    config: rtkConfigSchema.optional(),
  })
  .strict();
