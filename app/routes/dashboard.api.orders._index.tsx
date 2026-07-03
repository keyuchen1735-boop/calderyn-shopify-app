import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { loadOrdersPage } from "~/lib/order/list.server";

// Owned-orders read model for the dashboard Orders screen: live orders,
// open draft carts, stalled checkouts, and carrier-invoice ship charges.
export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(() => loadOrdersPage(session.shopId));
}
