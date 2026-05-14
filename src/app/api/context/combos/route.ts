import { NextResponse } from "next/server";
import { createCompressionCombo, listCompressionCombos } from "@/lib/db/compressionCombos";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { compressionComboCreateSchema } from "./schemas";

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  return NextResponse.json({ combos: listCompressionCombos() });
}

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const validation = validateBody(compressionComboCreateSchema, rawBody);
  if (isValidationFailure(validation)) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const combo = createCompressionCombo(validation.data);
  return NextResponse.json(combo, { status: 201 });
}
