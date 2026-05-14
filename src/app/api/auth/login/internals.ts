import { cookies } from "next/headers";

// Test seam for cookie store injection without affecting runtime behavior.
// Lives in a sibling file so Next.js does not see it as a route export.
export const authRouteInternals = {
  getCookieStore: cookies,
};
