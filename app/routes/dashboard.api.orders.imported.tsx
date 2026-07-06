import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { loadImportedOrdersPage } from "~/lib/order/imported-list.server";

// Read model for the Orders screen "Imported" subtab: historical orders + refunds
// brought over by Import-from-Shopify (imported_order / imported_refund). Read-only
// — these were paid on Shopify, so Calderyn cannot act on their money here.
export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(() => loadImportedOrdersPage(session.shopId));
}
