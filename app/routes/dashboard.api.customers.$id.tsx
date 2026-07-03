import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError } from "~/lib/dashboard/http.server";
import { loadCustomerDetail } from "~/lib/buyer/directory.server";

// One buyer's full profile: aggregates, addresses, latest consents, recent
// orders, and any open cart. 404s when the buyer isn't in this shop.
export async function loader({ request, params }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  const id = String(params.id);
  return dashboardJson(async () => {
    const detail = await loadCustomerDetail(session.shopId, id);
    if (!detail) throw jsonError(404, "not_found");
    return detail;
  });
}
