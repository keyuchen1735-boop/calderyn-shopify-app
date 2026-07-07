import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { loadCustomersPage } from "~/lib/buyer/directory.server";

// Customer-directory read model for the dashboard Customers screen: headline
// stats, the buyer list with computed segments, and the segment definitions.
export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => loadCustomersPage(session.shopId));
}
