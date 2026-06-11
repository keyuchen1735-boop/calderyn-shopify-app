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

/** A row from `ad_spend_fact` (campaign × day) used for account CTR/CPM/CVR. */
export interface SpendRow {
  impressions?: number | null;
  clicks?: number | null;
  spend_cents?: number | null;
  conversions?: number | null;
}

/**
 * Pure account-level aggregates from `ad_spend_fact` rows. A metric is null when
 * its denominator is zero (no division possible) so fallbacks apply downstream.
 * CTR can legitimately be 0 (impressions but no clicks); CVR is null without clicks.
 */
export function aggregateSpend(rows: SpendRow[]): {
  ctr: number | null;
  cpmCents: number | null;
  cvr: number | null;
} {
  let impressions = 0;
  let clicks = 0;
  let spendCents = 0;
  let conversions = 0;
  for (const r of rows) {
    impressions += Number(r.impressions ?? 0);
    clicks += Number(r.clicks ?? 0);
    spendCents += Number(r.spend_cents ?? 0);
    conversions += Number(r.conversions ?? 0);
  }
  return {
    ctr: impressions > 0 ? clicks / impressions : null,
    cpmCents: impressions > 0 ? (spendCents / impressions) * 1000 : null,
    cvr: clicks > 0 ? conversions / clicks : null,
  };
}

/** A row from `ad_engagement_fact` (ad × day) used for engagement + ad count. */
export interface EngagementRow {
  day?: string | null;
  impressions?: number | null;
  reactions?: number | null;
  comments?: number | null;
  shares?: number | null;
  saves?: number | null;
  ad_external_id?: string | null;
}

/**
 * Pure aggregates from `ad_engagement_fact` rows. `engagementRate` is summed over
 * rows on/after `sinceISO` (ISO date strings compare chronologically); it is null
 * without in-window impressions. `historyAdCount` is the distinct ad count over
 * ALL rows — it gauges total account history, so it ignores the window.
 */
export function aggregateEngagement(
  rows: EngagementRow[],
  sinceISO: string,
): { engagementRate: number | null; historyAdCount: number } {
  let windowImpressions = 0;
  let windowEngagement = 0;
  const ads = new Set<string>();
  for (const r of rows) {
    const id = typeof r.ad_external_id === "string" ? r.ad_external_id.trim() : "";
    if (id) ads.add(id);
    if (typeof r.day === "string" && r.day >= sinceISO) {
      windowImpressions += Number(r.impressions ?? 0);
      windowEngagement +=
        Number(r.reactions ?? 0) +
        Number(r.comments ?? 0) +
        Number(r.shares ?? 0) +
        Number(r.saves ?? 0);
    }
  }
  return {
    engagementRate: windowImpressions > 0 ? windowEngagement / windowImpressions : null,
    historyAdCount: ads.size,
  };
}

/** A row from `order_line_fact` carrying the realized unit price. */
export interface PriceLine {
  price_cents?: number | null;
}

/**
 * Mean realized unit price (whole cents) across order lines, ignoring non-positive
 * values. `sku_dim` carries no retail price, so what the SKU actually sold for is
 * the honest source. Null when no positive prices exist.
 */
export function avgPriceCents(lines: PriceLine[]): number | null {
  const prices = lines
    .map((l) => Number(l.price_cents ?? 0))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (prices.length === 0) return null;
  return Math.round(prices.reduce((s, n) => s + n, 0) / prices.length);
}

/**
 * Read calibration inputs for a shop from real Supabase facts. `mappedSku`
 * (resolved from the creative's destination URL in the orchestrator) selects the
 * SKU price. Account CTR/CPM/CVR/engagement use a trailing 30-day window; the
 * distinct-ad count is all-time. Missing data (empty account / unmapped SKU)
 * leaves the relevant raw field null → shapeCalibrationInputs supplies documented
 * fallbacks (cold start). `now` is injectable for deterministic tests.
 */
export async function loadCalibrationInputs(
  shop: string,
  mappedSku: string | null,
  now: Date = new Date(),
): Promise<CalibrationInputs> {
  const sb = getSupabase();
  const shopId = await resolveShopId(shop);
  const sinceISO = new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);

  // Account CTR / CPM / CVR from spend facts over the trailing 30 days.
  const spend = await sb
    .from("ad_spend_fact")
    .select("impressions, clicks, spend_cents, conversions")
    .eq("shop_id", shopId)
    .gte("day", sinceISO)
    .limit(5000);
  if (spend.error) throw spend.error;
  const { ctr, cpmCents, cvr } = aggregateSpend((spend.data ?? []) as SpendRow[]);

  // Engagement rate (trailing 30d) + total distinct ads run (all-time, capped).
  const engagement = await sb
    .from("ad_engagement_fact")
    .select("day, impressions, reactions, comments, shares, saves, ad_external_id")
    .eq("shop_id", shopId)
    .order("day", { ascending: false })
    .limit(2000);
  if (engagement.error) throw engagement.error;
  const { engagementRate, historyAdCount } = aggregateEngagement(
    (engagement.data ?? []) as EngagementRow[],
    sinceISO,
  );

  // Account-level grade aggregates (break-even ROAS) — most recent per campaign.
  const grades = await sb
    .from("campaign_grade_fact")
    .select("break_even_roas")
    .eq("shop_id", shopId)
    .limit(200);
  if (grades.error) throw grades.error;
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
  if (eng.error) throw eng.error;
  const topAdNames = Array.from(
    new Set(
      (eng.data ?? [])
        .map((r) => (r as { ad_campaign_dim?: { name?: string } }).ad_campaign_dim?.name)
        .filter((n): n is string => typeof n === "string"),
    ),
  ).slice(0, 3);

  // Realized SKU price: sku_dim carries no retail price, so resolve the SKU id and
  // average what it actually sold for in order_line_fact.
  let skuPriceCents: number | null = null;
  if (mappedSku) {
    const sku = await sb
      .from("sku_dim")
      .select("id")
      .eq("shop_id", shopId)
      .eq("sku", mappedSku)
      .maybeSingle();
    if (sku.error) throw sku.error;
    const skuId = (sku.data as { id?: string } | null)?.id;
    if (skuId) {
      const lines = await sb
        .from("order_line_fact")
        .select("price_cents")
        .eq("shop_id", shopId)
        .eq("sku_id", skuId)
        .limit(500);
      if (lines.error) throw lines.error;
      skuPriceCents = avgPriceCents((lines.data ?? []) as PriceLine[]);
    }
  }

  const raw: RawHistory = {
    ctr,
    cpmCents,
    engagementRate,
    breakEvenRoas,
    mappedSku,
    skuPriceCents,
    skuCvr: cvr,
    topAdNames,
    historyAdCount,
  };
  return shapeCalibrationInputs(raw);
}
