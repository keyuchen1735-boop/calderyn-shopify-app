import type { SkuDemandViewRow } from "../inventory-demand";
import { suggestedTransferFromRow } from "../inventory-demand";
import { isValidRegion, type RegionCode } from "../ads/actions";
import type { WeatherAlertDraft } from "./drafts";

// Only nudge when the demand region's weather is meaningfully demand-favorable;
// mild forecasts must not manufacture inventory moves (weather is a secondary signal).
export const WEATHER_DEMAND_SCORE_FLOOR = 0.35;

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
    entityRef: { sku_id: skuId, region, sku: skuId, title: `Move stock to ${region}` },
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
      sku_title: skuId,
    },
  };
}
