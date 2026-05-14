import { z } from "zod";

export const assignmentsUpdateSchema = z
  .object({
    routingComboIds: z.array(z.string().trim().min(1)),
  })
  .strict();
