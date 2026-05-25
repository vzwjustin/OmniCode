import { NextResponse } from "next/server";
import {
  deleteCompressionCombo,
  getCompressionCombo,
  setDefaultCompressionCombo,
  updateCompressionCombo,
} from "@/lib/db/compressionCombos";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { compressionComboUpdateSchema } from "@/server/compression/apiSchemas";

export async function GET(request: Request, { params }) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const { id } = await params;
  const combo = getCompressionCombo(id);
  if (!combo) return NextResponse.json({ error: "Compression combo not found" }, { status: 404 });
  return NextResponse.json(combo);
}

export async function PUT(request: Request, { params }) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const { id } = await params;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const validation = validateBody(compressionComboUpdateSchema, rawBody);
  if (isValidationFailure(validation)) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  if (validation.data.isDefault === true) {
    const changed = setDefaultCompressionCombo(id);
    if (!changed)
      return NextResponse.json({ error: "Compression combo not found" }, { status: 404 });
  }

  const combo = updateCompressionCombo(id, validation.data);
  if (!combo) return NextResponse.json({ error: "Compression combo not found" }, { status: 404 });
  return NextResponse.json(combo);
}

export async function DELETE(request: Request, { params }) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const { id } = await params;
  const deleted = deleteCompressionCombo(id);
  if (!deleted) {
    return NextResponse.json(
      { error: "Compression combo not found or cannot delete default combo" },
      { status: 404 }
    );
  }
  return NextResponse.json({ ok: true });
}
