import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { loadCustomersPage } from "~/lib/buyer/directory.server";
import { getSupabase } from "~/lib/supabase.server";
import { loadWeatherSuggestions } from "~/lib/weather/suggestions.server";

// Customer-directory read model for the dashboard Customers screen: headline
// stats, the buyer list with computed segments, the segment definitions, and
// the weather predictions (freshest pending + all armed) still inside their
// forecast horizon.
export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => {
    const [page, weatherSuggestions] = await Promise.all([
      loadCustomersPage(session.shopId),
      loadWeatherSuggestions(session.shopId, getSupabase()),
    ]);
    return { ...page, weatherSuggestions };
  });
}
