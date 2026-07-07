import type { SupabaseClient } from "@supabase/supabase-js";
import type { WeatherAlertDraft } from "./drafts";

/** Write (idempotently) one weather_demand alert + its evidence via the canonical
 *  upsert RPC. dayBucket is an ISO YYYY-MM-DD string. Returns the alert id. */
export async function writeWeatherAlert(
  sb: SupabaseClient,
  shopId: string,
  dayBucket: string,
  draft: WeatherAlertDraft,
): Promise<string> {
  const { data, error } = await sb.rpc("upsert_weather_alert", {
    p_shop_id: shopId,
    p_detector_id: "weather_demand",
    p_entity_ref: draft.entityRef,
    p_severity: draft.severity,
    p_dollar_impact: draft.dollarImpact,
    p_day_bucket: dayBucket,
    p_narrative: draft.narrative,
    p_rank: draft.rank,
    p_evidence: draft.evidence,
  });
  if (error) throw new Error(error.message);
  return String(data);
}
