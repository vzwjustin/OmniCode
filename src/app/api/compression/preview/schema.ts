import { z } from "zod";
import { compressionPreviewConfigSchema } from "@/shared/validation/compressionConfigSchemas";

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
