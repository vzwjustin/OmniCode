import { NextResponse } from "next/server";
import {
  SEARCH_PROVIDERS,
  SEARCH_CREDENTIAL_FALLBACKS,
} from "@omniroute/open-sse/config/searchRegistry.ts";
import { getProviderConnections } from "@/lib/db/providers";
import { isAuthenticated } from "@/shared/utils/apiAuth";

export async function GET(request: Request) {
  if (!(await isAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const providers = await Promise.all(
      Object.values(SEARCH_PROVIDERS).map(async (p) => {
        let status: "active" | "no_credentials" = "no_credentials";
        try {
          const cred = (await getProviderConnections({ provider: p.id, isActive: true }))[0];
          const fallbackId = SEARCH_CREDENTIAL_FALLBACKS[p.id];
          const fallbackCred =
            !cred && fallbackId
              ? (await getProviderConnections({ provider: fallbackId, isActive: true }))[0]
              : null;
          if (cred || fallbackCred) status = "active";
        } catch {
          // DB error — report as no_credentials
        }
        return {
          id: p.id,
          name: p.name,
          status,
          cost_per_query: p.costPerQuery,
        };
      })
    );

    return NextResponse.json({ providers });
  } catch (error) {
    return NextResponse.json({ error: "Failed to list providers" }, { status: 500 });
  }
}
