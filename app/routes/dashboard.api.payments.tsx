import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { loadPaymentsPage } from "~/lib/payments/summary.server";

// Payments read model for the dashboard Payments screen: 30-day ledger totals
// (gross volume, refunds, fees, payouts), in-flight PaymentIntents, and the
// latest transaction_ledger entries.
export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(() => loadPaymentsPage(session.shopId));
}
