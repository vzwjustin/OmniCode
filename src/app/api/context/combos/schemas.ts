import { z } from "zod";
import {
  cavemanIntensitySchema,
  stackedPipelineStepSchema,
} from "@/shared/validation/compressionConfigSchemas";

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
