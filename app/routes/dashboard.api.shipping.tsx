import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { loadShippingSummary } from "~/lib/shipping/summary.server";

// Shipping read model for the dashboard Shipping screen: ship-from origin,
// CarrierService registration, catalog ship-data coverage, the quote engine's
// static fallback rate card, and 30-day quote activity.
export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(() => loadShippingSummary(session.shopId));
}
