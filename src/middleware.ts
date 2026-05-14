import type { NextRequest } from "next/server";
import { runAuthzPipeline } from "./server/authz/pipeline";

/**
 * Next.js middleware entry point.
 *
 * Originally named `proxy.ts`, but Next.js App Router only auto-registers a
 * middleware module when the file is named `middleware.ts` at the root of the
 * `src/` directory. Renaming activates the authz pipeline for the routes
 * declared in `config.matcher` below — without this file, requests bypass the
 * security pipeline entirely.
 */
export async function middleware(request: NextRequest) {
  return runAuthzPipeline(request, { enforce: true });
}

export const config = {
  runtime: "nodejs",
  matcher: [
    "/",
    "/dashboard/:path*",
    "/api/:path*",
    "/v1/:path*",
    "/v1",
    "/chat/:path*",
    "/responses/:path*",
    "/responses",
    "/codex/:path*",
    "/codex",
    "/models",
  ],
};
