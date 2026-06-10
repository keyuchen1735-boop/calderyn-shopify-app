import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { calderynClient } from "~/lib/calderyn.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => {
    const client = calderynClient(session.shopDomain);
    const [roasSeries, campaigns, openAlerts] = await Promise.all([
      client.analytics.dailyRoasSeries(30),
      client.campaigns.list(),
      client.alerts.list({ status: "open" }),
    ]);
    return {
      roas_series: roasSeries,
      campaign_count: campaigns.length,
      active_campaign_count: campaigns.filter((c) => c.status === "active").length,
      open_alert_count: openAlerts.length,
      open_alert_dollar_impact_cents: openAlerts.reduce(
        (sum, a) => sum + a.dollar_impact,
        0,
      ),
    };
  });
}
