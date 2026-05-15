import { NextRequest, NextResponse } from "next/server";
import {
  listSemanticCacheEntries,
  deleteSemanticCacheBySignature,
  deleteSemanticCacheByModel,
} from "@/lib/db/semanticCache";
import { isAuthenticated } from "@/shared/utils/apiAuth";

export async function GET(req: NextRequest) {
  if (!(await isAuthenticated(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(req.url);
    const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") || "20", 10)));
    const search = searchParams.get("search") || "";
    const model = searchParams.get("model") || "";
    const sortBy = searchParams.get("sortBy") || "created_at";
    const sortOrder = searchParams.get("sortOrder") === "asc" ? "asc" : "desc";

    const { entries, total } = listSemanticCacheEntries({
      page,
      limit,
      search,
      model,
      sortBy,
      sortOrder,
    });

    return NextResponse.json({
      entries,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!(await isAuthenticated(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(req.url);
    const signature = searchParams.get("signature");
    const model = searchParams.get("model");

    if (signature) {
      deleteSemanticCacheBySignature(signature);
      return NextResponse.json({ ok: true, deleted: 1 });
    }

    if (model) {
      const deleted = deleteSemanticCacheByModel(model);
      return NextResponse.json({ ok: true, deleted });
    }

    return NextResponse.json({ error: "Provide signature or model parameter" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
