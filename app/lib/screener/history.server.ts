// app/lib/screener/history.server.ts
import { getSupabase, resolveShopId } from "../supabase.server";
import {
  DEFAULT_BASELINE_CPM_CENTS, DEFAULT_BASELINE_CTR, DEFAULT_BREAK_EVEN_ROAS,
  DEFAULT_ENGAGEMENT_RATE, type CalibrationInputs,
} from "./types";

/** Raw aggregates pulled from Supabase; nulls mean "no data yet". */
export interface RawHistory {
  ctr: number | null;
  cpmCents: number | null;
  engagementRate: number | null;
  breakEvenRoas: number | null;
  mappedSku: string | null;
  skuPriceCents: number | null;
  skuCvr: number | null;
  topAdNames: string[];
  historyAdCount: number;
}

/** Pure shaping: raw aggregates → CalibrationInputs with documented fallbacks. */
export function shapeCalibrationInputs(raw: RawHistory): CalibrationInputs {
  return {
    accountBaselineCtr: raw.ctr ?? DEFAULT_BASELINE_CTR,
    accountBaselineCpmCents: raw.cpmCents ?? DEFAULT_BASELINE_CPM_CENTS,
    accountEngagementRate: raw.engagementRate ?? DEFAULT_ENGAGEMENT_RATE,
    breakEvenRoas: raw.breakEvenRoas ?? DEFAULT_BREAK_EVEN_ROAS,
    mappedSku: raw.mappedSku,
    skuPriceCents: raw.skuPriceCents,
    skuCvr: raw.skuCvr,
    topAdNames: raw.topAdNames,
    historyAdCount: raw.historyAdCount,
  };
}

/**
 * Read calibration inputs for a shop. `mappedSku` (resolved from the creative's
 * destination URL in the orchestrator) selects the SKU price/CVR. On any read
 * error or empty account this returns all-null raw → shapeCalibrationInputs
 * supplies fallbacks (cold start), never throwing.
 */
export async function loadCalibrationInputs(
  shop: string,
  mappedSku: string | null,
): Promise<CalibrationInputs> {
  const sb = getSupabase();
  const shopId = await resolveShopId(shop);

  // Account-level grade aggregates (roas, break_even) — most recent per campaign.
  const grades = await sb
    .from("campaign_grade_fact")
    .select("break_even_roas")
    .eq("shop_id", shopId)
    .limit(200);

  const breakEvens = (grades.data ?? [])
    .map((r) => Number((r as { break_even_roas?: unknown }).break_even_roas))
    .filter((n) => Number.isFinite(n) && n > 0);
  const breakEvenRoas = breakEvens.length
    ? breakEvens.reduce((s, n) => s + n, 0) / breakEvens.length
    : null;

  // Top ad names by engagement (best-effort; empty on no data).
  const eng = await sb
    .from("ad_engagement_fact")
    .select("ad_campaign_dim(name)")
    .eq("shop_id", shopId)
    .limit(50);
  const topAdNames = Array.from(
    new Set(
      (eng.data ?? [])
        .map((r) => (r as { ad_campaign_dim?: { name?: string } }).ad_campaign_dim?.name)
        .filter((n): n is string => typeof n === "string"),
    ),
  ).slice(0, 3);

  // SKU price for the mapped SKU, if any.
  let skuPriceCents: number | null = null;
  if (mappedSku) {
    const sku = await sb
      .from("sku_dim")
      .select("price_cents")
      .eq("shop_id", shopId)
      .eq("sku", mappedSku)
      .maybeSingle();
    const p = Number((sku.data as { price_cents?: unknown } | null)?.price_cents);
    if (Number.isFinite(p) && p > 0) skuPriceCents = p;
  }

  // CTR/CPM/engagement/CVR account baselines are not yet materialized as a single
  // view; Plan 1 leaves them null so documented fallbacks apply. Plan 2 wires the
  // real ad_spend_fact / order_fact aggregates here.
  const raw: RawHistory = {
    ctr: null,
    cpmCents: null,
    engagementRate: null,
    breakEvenRoas,
    mappedSku,
    skuPriceCents,
    skuCvr: null,
    topAdNames,
    historyAdCount: topAdNames.length, // proxy until Plan 2's real count
  };
  return shapeCalibrationInputs(raw);
}
