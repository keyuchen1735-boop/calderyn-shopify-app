// Ad-level Meta Insights for the campaign detail page: each ad's REAL, live
// performance over the last 7 days, shown beside its predictive scorecard.
//
// Unlike transform.ts (which defaults missing fields to 0 — correct for
// ingestion/aggregation), the display feature must NEVER fake a 0 for missing
// data (rule 12). So the parsers here return `null` on a missing/blank/non-finite
// field, and the UI renders "— (no data)". An ad with no delivery has NO row in
// the response and so never appears in the result — the caller treats absent as
// "no data" too.

import type { MetaClient, MetaResponse } from "./campaigns.server";
import { assertNotRateLimited } from "./insights.server";

export interface AdMetrics {
  adId: string;
  spendCents: number | null;
  impressions: number | null;
  clicks: number | null;
  ctr: number | null; // percent, e.g. 1.23 means 1.23% (Meta returns it already as a percent)
  cpmCents: number | null; // cost per 1000 impressions, major-unit string → cents
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Finite Number, else null. Blank string / absent / non-numeric → null (NOT 0). */
function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Major-unit money (string/number) → cents, else null. Never defaults to 0. */
function centsOrNull(value: unknown): number | null {
  const n = numOrNull(value);
  return n === null ? null : Math.round(n * 100);
}

/** Integer count, else null. Never defaults to 0. */
function intOrNull(value: unknown): number | null {
  const n = numOrNull(value);
  return n === null ? null : Math.round(n);
}

/** Coerce to a string, else "". */
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// PURE — never throws. Missing/blank/non-finite field → null (NOT 0); adId "" if absent.
export function parseAdInsightRow(raw: unknown): AdMetrics {
  if (!isObject(raw)) {
    return {
      adId: "",
      spendCents: null,
      impressions: null,
      clicks: null,
      ctr: null,
      cpmCents: null,
    };
  }
  return {
    adId: str(raw.ad_id),
    spendCents: centsOrNull(raw.spend),
    impressions: intOrNull(raw.impressions),
    clicks: intOrNull(raw.clicks),
    ctr: numOrNull(raw.ctr),
    cpmCents: centsOrNull(raw.cpm),
  };
}

// I/O — one row per ad over the 7-day window. Pages through paging.next like
// fetchMetaInsights, mirroring its assertNotRateLimited + error-throw handling.
// An ad with no delivery simply has no row, so it won't appear in the result.
export async function listCampaignAdInsights(
  client: MetaClient,
  campaignId: string,
): Promise<AdMetrics[]> {
  const baseParams: Record<string, string> = {
    level: "ad",
    date_preset: "last_7d",
    fields: "ad_id,impressions,clicks,spend,ctr,cpm",
    limit: "500",
  };

  const rows: AdMetrics[] = [];
  let after: string | undefined;

  do {
    const params = after ? { ...baseParams, after } : baseParams;
    const res: MetaResponse = assertNotRateLimited(
      await client.get(`/${campaignId}/insights`, params),
    );
    if (res.error) throw new Error(`Meta Insights error: ${res.error.message}`);
    const page = (res.data as unknown[]) ?? [];
    for (const r of page) rows.push(parseAdInsightRow(r));
    const paging = (res as { paging?: { next?: string; cursors?: { after?: string } } }).paging;
    after = paging?.next ? paging.cursors?.after : undefined;
  } while (after);

  return rows;
}
