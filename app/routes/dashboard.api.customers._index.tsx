import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson } from "~/lib/dashboard/http.server";
import { loadCustomersPage } from "~/lib/buyer/directory.server";
import { getSupabase } from "~/lib/supabase.server";
import type { WeatherSuggestionDTO } from "~/lib/weather/types";

async function loadWeatherSuggestions(shopId: string): Promise<WeatherSuggestionDTO[]> {
  const sb = getSupabase();
  const today = new Date().toISOString().slice(0, 10);
  // Armed predictions stay visible until they fire or expire; a pending one
  // is only offered on its own day (the next cron writes a fresh one).
  // Filtered DB-side so the result stays bounded regardless of history.
  const { data, error } = await sb
    .from("weather_suggestion")
    .select("id, narrative, amount_cents, status, expires_on")
    .eq("shop_id", shopId)
    .or(`status.eq.armed,and(status.eq.pending,suggested_on.eq.${today})`)
    .order("amount_cents", { ascending: false });
  if (error) throw error;
  return (data ?? [])
    .map((r) => ({
      id: String(r.id),
      narrative: String(r.narrative),
      amountCents: Number(r.amount_cents),
      status: r.status === "armed" ? ("armed" as const) : ("pending" as const),
      expiresOn: String(r.expires_on),
    }));
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
