import { z } from "zod";
import { INSPECT_LIMITS } from "./limits.js";

export const metadataSchema = z.record(z.string(), z.unknown());

const oneBasedPositionSchema = z.number().int().min(1);

export const SourceLocationSchema = z
  .object({
    uri: z.string().min(1).max(INSPECT_LIMITS.urlLength),
    line: oneBasedPositionSchema,
    column: oneBasedPositionSchema,
    endLine: oneBasedPositionSchema.optional(),
    endColumn: oneBasedPositionSchema.optional(),
    metadata: metadataSchema,
  })
  .strict()
  .superRefine((location, context) => {
    const hasEndLine = location.endLine !== undefined;
    const hasEndColumn = location.endColumn !== undefined;

    if (hasEndLine !== hasEndColumn) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "endLine and endColumn must be provided together",
        path: hasEndLine ? ["endColumn"] : ["endLine"],
      });
      return;
    }

    if (!hasEndLine || !hasEndColumn) {
      return;
    }

    const endsBeforeStart =
      location.endLine! < location.line ||
      (location.endLine === location.line &&
        location.endColumn! < location.column);

    if (endsBeforeStart) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "source range end must not be before start",
        path: ["endLine"],
      });
    }
  });

export type SourceLocation = z.infer<typeof SourceLocationSchema>;
