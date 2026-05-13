import { redirect } from "next/navigation";

// MCP management is being consolidated into Settings while the dedicated
// dashboard is built out. The Endpoint page links here, so render a redirect
// stub to avoid a 404. Replace with a real page once the MCP dashboard ships.
export default function McpDashboardStubPage() {
  redirect("/dashboard/settings");
}
