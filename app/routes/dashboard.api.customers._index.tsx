import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { loadCustomersPage } from "~/lib/buyer/directory.server";
import { getSupabase } from "~/lib/supabase.server";
import type { WeatherSuggestionDTO } from "~/lib/weather/types";

async function loadWeatherSuggestions(shopId: string): Promise<WeatherSuggestionDTO[]> {
  const sb = getSupabase();
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await sb
    .from("weather_suggestion")
    .select("id, narrative, amount_cents")
    .eq("shop_id", shopId)
    .eq("suggested_on", today)
    .eq("status", "pending")
    .order("amount_cents", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((r) => ({ id: String(r.id), narrative: String(r.narrative), amountCents: Number(r.amount_cents) }));
}

// Customer-directory read model for the dashboard Customers screen: headline
// stats, the buyer list with computed segments, the segment definitions, and
// today's pending weather-reallocation suggestions.
export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => {
    const [page, weatherSuggestions] = await Promise.all([
      loadCustomersPage(session.shopId),
      loadWeatherSuggestions(session.shopId),
    ]);
    return { ...page, weatherSuggestions };
  });
}
