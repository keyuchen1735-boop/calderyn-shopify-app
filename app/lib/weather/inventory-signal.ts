import type { SkuDemandViewRow } from "../inventory-demand";
import { suggestedTransferFromRow } from "../inventory-demand";
import { isValidRegion, type RegionCode } from "../ads/actions";
import type { WeatherAlertDraft } from "./drafts";

// Only nudge when the demand region's weather predicts CLEARLY elevated demand.
// favorability() is 0.5 at neutral weather and rises toward ~0.7 only for clearly
// bad (cold/wet/dark) weather, so the floor sits above the neutral midpoint —
// mild or good weather must never manufacture an inventory move (weather is a
// secondary, occasional signal, per the asymmetric demand model in score.ts).
export const WEATHER_DEMAND_SCORE_FLOOR = 0.55;

export function inventoryDraft(
  row: SkuDemandViewRow,
  regionScores: Map<RegionCode, number>,
): WeatherAlertDraft | null {
  const region = row.main_demand_region;
  if (!isValidRegion(region)) return null;
  const score = regionScores.get(region) ?? 0;
  if (score < WEATHER_DEMAND_SCORE_FLOOR) return null;

  const plan = suggestedTransferFromRow(row);
  if (!plan) return null;

  const skuId = row.sku_id;
  return {
    // No `sku` key: v_sku_regional_demand only exposes sku_id (the sku_dim uuid).
    // v_alerts_view / v_autopilot_candidates resolve the human SKU code from
    // sku_id via their sku_dim join, and executeInventoryAlertAction backfills
    // the reward loop's sku_id from that resolved code. Putting the uuid in `sku`
    // would show a raw uuid AND break that sku-code -> sku_id lookup.
    entityRef: { sku_id: skuId, region, title: `Move stock to ${region}` },
    severity: "medium",
    dollarImpact: 0,
    rank: 45,
    narrative:
      `Weather forecast favors demand in ${region} over the next 3 days, and you're low ` +
      `on cover there. Move ${plan.recommended_delta} units from ${plan.from_location_name} ` +
      `to ${plan.to_location_name} ahead of it.`,
    evidence: {
      inventory_item_id: plan.inventory_item_id,
      from_location_id: plan.from_location_id,
      to_location_id: plan.to_location_id,
      recommended_delta: plan.recommended_delta,
      region,
      weather_score: score,
    },
  };
}
