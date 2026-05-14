import { z } from "zod";
import { rtkConfigSchema } from "@/shared/validation/compressionConfigSchemas";

export const rtkTestSchema = z
  .object({
    text: z.string().min(1),
    command: z.string().optional(),
    config: rtkConfigSchema.optional(),
  })
  .strict();
