import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { loadCommerceAnalytics, parseWindowDays } from "~/lib/analytics/commerce.server";

// Commerce read model for the Analytics Performance view: daily sales/session
// series, window totals, channel + product mix, conversion funnel and agentic
// stats over the owned order spine. Read-only; ?days=7|14|30 (default 30).
export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  const days = parseWindowDays(new URL(request.url).searchParams.get("days"));
  return dashboardJson(() => loadCommerceAnalytics(session.shopId, days));
}
