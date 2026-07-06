// Read model for the Customers → Weather panel: the shop's single freshest
// pending weather-reallocation suggestion, if any, while it is still inside
// its forecast horizon.
//
// Single row on purpose: the cron emits at most one move per run, so the
// newest row supersedes every earlier proposal — prior days' rows for the same
// campaign pair (suggested_on is part of the unique key, so a persistent
// weather pattern writes one row per day) and same-day re-run rows with a
// flipped pair. Surfacing more than one would let a merchant compound what was
// meant to be a single move.
//
// Visibility runs FORECAST_HORIZON_DAYS UTC days from suggested_on — filtering
// to exactly "today" made rows vanish at UTC midnight (8pm ET) while still
// valid. Opted-out shops (weather_sensitivity = 0) see nothing, matching the
// CustomersPage contract.
import type { SupabaseClient } from "@supabase/supabase-js";
import { FORECAST_HORIZON_DAYS } from "./open-meteo.server";
import type { WeatherSuggestionDTO } from "./types";

const DAY_MS = 86_400_000;

export async function loadWeatherSuggestions(
  shopId: string,
  sb: SupabaseClient,
  now: Date = new Date(),
): Promise<WeatherSuggestionDTO[]> {
  const windowStart = new Date(now.getTime() - (FORECAST_HORIZON_DAYS - 1) * DAY_MS)
    .toISOString()
    .slice(0, 10);
  const [cfgRes, rowsRes] = await Promise.all([
    sb.from("guardrail_config").select("weather_sensitivity").eq("shop_id", shopId).maybeSingle(),
    sb
      .from("weather_suggestion")
      .select("id, narrative, amount_cents")
      .eq("shop_id", shopId)
      .eq("status", "pending")
      .gte("suggested_on", windowStart)
      .order("suggested_on", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(1),
  ]);
  if (cfgRes.error) throw cfgRes.error;
  if (rowsRes.error) throw rowsRes.error;

  const sensitivity = Number(
    (cfgRes.data as { weather_sensitivity?: unknown } | null)?.weather_sensitivity ?? 0,
  );
  if (!(sensitivity > 0)) return [];

  return (rowsRes.data ?? []).map((r) => ({
    id: String(r.id),
    narrative: String(r.narrative),
    amountCents: Number(r.amount_cents),
  }));
}
