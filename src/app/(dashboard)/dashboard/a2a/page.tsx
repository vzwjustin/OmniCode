import { redirect } from "next/navigation";

// A2A management is consolidated into the Agents dashboard while the
// dedicated A2A page is being built. The Endpoint page links here, so render
// a redirect stub to avoid a 404. Replace with a real page once the A2A
// dashboard ships.
export default function A2aDashboardStubPage() {
  redirect("/dashboard/agents");
}
