// Weather-driven reallocation suggester. Pure ranking/sizing (buildSuggestion)
// plus DB glue (loadGeoSegmentedCampaigns / runWeatherSuggestForShop, below).
// Sizing lives HERE, not in the model or the approval route: the merchant's
// weather_sensitivity dial scales a move as a fraction of the source budget,
// bounded so it always leaves the source positive.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RegionCode } from "../ads/actions";
import { regionForGeoTargets } from "../ads/geo-regions";
import { favorability, type RegionForecast } from "../weather/score";
import { REGION_CENTROIDS } from "../weather/regions";
import { fetchRegionForecasts } from "../weather/open-meteo.server";

export const SCORE_GAP_FLOOR = 0.15;
export const MAX_CUT_FRACTION = 0.9;
export const MIN_MOVE_CENTS = 100;

export interface EligibleCampaign {
  campaignId: string;
  region: RegionCode;
  dailyBudgetCents: number;
  name: string;
}

export interface BuiltSuggestion {
  sourceRegion: RegionCode;
  destRegion: RegionCode;
  sourceCampaignId: string;
  destCampaignId: string;
  amountCents: number;
  sourceScore: number;
  destScore: number;
  narrative: string;
}

const dollars = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

export function buildSuggestion(
  campaigns: EligibleCampaign[],
  scores: Map<RegionCode, number>,
  sensitivityPct: number,
): BuiltSuggestion | null {
  if (sensitivityPct <= 0) return null;

  const byRegion = new Map<RegionCode, EligibleCampaign[]>();
  for (const c of campaigns) {
    const list = byRegion.get(c.region) ?? [];
    list.push(c);
    byRegion.set(c.region, list);
  }
  if (byRegion.size < 2) return null;

  const ranked = [...byRegion.keys()].sort((a, b) => (scores.get(a) ?? 0) - (scores.get(b) ?? 0));
  const sourceRegion = ranked[0];
  const destRegion = ranked[ranked.length - 1];
  const sourceScore = scores.get(sourceRegion) ?? 0;
  const destScore = scores.get(destRegion) ?? 0;
  if (destScore - sourceScore < SCORE_GAP_FLOOR) return null;

  const pickBiggest = (r: RegionCode): EligibleCampaign =>
    byRegion.get(r)!.slice().sort((a, b) => b.dailyBudgetCents - a.dailyBudgetCents)[0];
  const source = pickBiggest(sourceRegion);
  const dest = pickBiggest(destRegion);

  const raw = Math.round(source.dailyBudgetCents * (sensitivityPct / 100) * (destScore - sourceScore));
  const capped = Math.min(raw, Math.floor(source.dailyBudgetCents * MAX_CUT_FRACTION));
  if (capped < MIN_MOVE_CENTS) return null;

  const narrative =
    `Next 3 days: ${destRegion} weather favors demand (score ${destScore.toFixed(2)}) ` +
    `vs ${sourceRegion} (${sourceScore.toFixed(2)}). Shift ${dollars(capped)}/day from ` +
    `"${source.name}" to "${dest.name}".`;

  return {
    sourceRegion, destRegion,
    sourceCampaignId: source.campaignId, destCampaignId: dest.campaignId,
    amountCents: capped, sourceScore, destScore, narrative,
  };
}

interface CampaignRow {
  id: string;
  name: string;
  status: string;
  daily_budget_cents: number | null;
  geo_targets: string[] | null;
}

/** Load a shop's active, budgeted, single-region campaigns. */
export async function loadGeoSegmentedCampaigns(
  shopId: string,
  sb: SupabaseClient,
): Promise<EligibleCampaign[]> {
  const { data, error } = await sb
    .from("ad_campaign_dim")
    .select("id, name, status, daily_budget_cents, geo_targets")
    .eq("shop_id", shopId)
    .eq("status", "active")
    .not("daily_budget_cents", "is", null);
  if (error) throw error;

  const out: EligibleCampaign[] = [];
  for (const c of (data ?? []) as CampaignRow[]) {
    if (c.daily_budget_cents == null) continue;
    const region = regionForGeoTargets(c.geo_targets ?? []);
    if (!region) continue;
    out.push({ campaignId: c.id, region, dailyBudgetCents: c.daily_budget_cents, name: c.name });
  }
  return out;
}

export interface RunDeps {
  fetchForecasts?: (points: typeof REGION_CENTROIDS) => Promise<Map<RegionCode, RegionForecast>>;
  today?: string;
}

export interface RunResult {
  suggested: number;
  skippedReason?: "sensitivity_off" | "no_eligible_campaigns" | "no_suggestion";
}

/**
 * Compute and upsert today's weather suggestion for one shop. Idempotent via the
 * unique (shop_id, suggested_on, source_campaign_id, dest_campaign_id) constraint.
 */
export async function runWeatherSuggestForShop(
  shopId: string,
  sb: SupabaseClient,
  deps: RunDeps = {},
): Promise<RunResult> {
  const { data: cfg } = await sb
    .from("guardrail_config")
    .select("weather_sensitivity")
    .eq("shop_id", shopId)
    .maybeSingle();
  const sensitivity = Number((cfg as { weather_sensitivity?: unknown } | null)?.weather_sensitivity ?? 0);
  if (!(sensitivity > 0)) return { suggested: 0, skippedReason: "sensitivity_off" };

  const campaigns = await loadGeoSegmentedCampaigns(shopId, sb);
  const regions = new Set(campaigns.map((c) => c.region));
  if (regions.size < 2) return { suggested: 0, skippedReason: "no_eligible_campaigns" };

  const fetchForecasts = deps.fetchForecasts ?? ((pts) => fetchRegionForecasts(pts));
  const forecasts = await fetchForecasts(REGION_CENTROIDS);
  const scores = new Map<RegionCode, number>();
  for (const [region, f] of forecasts) scores.set(region, favorability(f));

  const suggestion = buildSuggestion(campaigns, scores, sensitivity);
  if (!suggestion) return { suggested: 0, skippedReason: "no_suggestion" };

  const today = deps.today ?? new Date().toISOString().slice(0, 10);
  const { error } = await sb.from("weather_suggestion").upsert(
    [
      {
        shop_id: shopId,
        suggested_on: today,
        source_region: suggestion.sourceRegion,
        dest_region: suggestion.destRegion,
        source_campaign_id: suggestion.sourceCampaignId,
        dest_campaign_id: suggestion.destCampaignId,
        amount_cents: suggestion.amountCents,
        source_score: suggestion.sourceScore,
        dest_score: suggestion.destScore,
        narrative: suggestion.narrative,
        status: "pending",
      },
    ],
    { onConflict: "shop_id,suggested_on,source_campaign_id,dest_campaign_id" },
  );
  if (error) throw error;
  return { suggested: 1 };
}
