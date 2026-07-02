import type { LoaderFunctionArgs } from "react-router";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { checkDualRunDrift } from "~/lib/cutover/drift.server";

// GET: on-demand dual-run drift report — live Shopify values diffed against the owned
// tables. Read-only (nothing is written), so it lives in a loader. A flat sibling of
// dashboard.api.cutover so the status loader never runs as a parent route.
//
// Error mapping rides the standard envelope: drift.server throws CalderynError for the
// expected, merchant-actionable cases (409 not_connected, 502 shopify_unreachable with
// plain copy), and anything else stays dashboardJson's 500 that never masquerades as a
// comparison result.
export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => await checkDualRunDrift(session.shopId));
}
