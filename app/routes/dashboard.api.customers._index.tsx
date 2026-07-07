import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { loadCustomersPage } from "~/lib/buyer/directory.server";
import { getSupabase } from "~/lib/supabase.server";
import { loadWeatherSuggestions } from "~/lib/weather/suggestions.server";

// Customer-directory read model for the dashboard Customers screen: headline
// stats, the buyer list with computed segments, the segment definitions, and
// the pending weather-reallocation suggestions still inside their forecast
// horizon.
export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => {
    const [page, weatherSuggestions] = await Promise.all([
      loadCustomersPage(session.shopId),
      // The weather panel is a secondary, opt-in surface: a transient error or
      // schema drift on it must degrade to "no suggestions", never take down the
      // whole Customers screen (headline stats + buyer list).
      loadWeatherSuggestions(session.shopId, getSupabase()).catch((err) => {
        console.error("[customers] weather suggestions load failed; showing none", err);
        return [];
      }),
    ]);
    return { ...page, weatherSuggestions };
  });
}
