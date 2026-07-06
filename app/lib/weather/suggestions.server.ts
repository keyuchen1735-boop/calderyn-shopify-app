// Read model for the Customers → Weather panel: this shop's pending
// weather-reallocation suggestions that are still inside their forecast horizon.
// A suggestion is based on a 3-day forecast, so it stays actionable (and
// visible) for 3 UTC days from its suggested_on date — filtering to exactly
// "today" would make rows vanish at UTC midnight (8pm ET) while still valid.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { WeatherSuggestionDTO } from "./types";

const FORECAST_HORIZON_DAYS = 3;
const DAY_MS = 86_400_000;

export async function loadWeatherSuggestions(
  shopId: string,
  sb: SupabaseClient,
  now: Date = new Date(),
): Promise<WeatherSuggestionDTO[]> {
  const windowStart = new Date(now.getTime() - (FORECAST_HORIZON_DAYS - 1) * DAY_MS)
    .toISOString()
    .slice(0, 10);
  const { data, error } = await sb
    .from("weather_suggestion")
    .select("id, narrative, amount_cents, suggested_on")
    .eq("shop_id", shopId)
    .eq("status", "pending")
    .gte("suggested_on", windowStart)
    .order("suggested_on", { ascending: false })
    .order("amount_cents", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((r) => ({
    id: String(r.id),
    narrative: String(r.narrative),
    amountCents: Number(r.amount_cents),
  }));
}
