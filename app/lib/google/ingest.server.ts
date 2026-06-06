// Google Ads ingestion: 90-day backfill + daily poll.
//
// Refactored onto the generic ads core (app/lib/ads/ingest.server.ts).
// backfillGoogle / pollGoogleDaily are thin wrappers that:
//   1. Build a ShopAdSource via googleSource() (GAQL queries + transforms + raw archival)
//   2. Delegate upserts to backfillAds / pollAdsDaily
//   3. Preserve the existing shop_integrations sync_status bookkeeping
//
// Zero behavior change — existing tests stay green.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { GoogleAdsClient } from "./client.server";
import {
  transformCampaign,
  transformReportRow,
} from "./transform";
import type { GoogleCampaignPayload, GoogleReportRow } from "./types";
import { backfillAds, pollAdsDaily } from "../ads/ingest.server";
import type { ShopAdSource } from "../ads/adapter";

const CAMPAIGN_GAQL = `
  SELECT
    campaign.id,
    campaign.name,
    campaign.status,
    campaign.advertising_channel_type,
    campaign.start_date,
    campaign_budget.amount_micros,
    customer.currency_code
  FROM campaign
  WHERE campaign.status IN ('ENABLED', 'PAUSED')
`;

const REPORT_GAQL_90D = `
  SELECT
    campaign.id,
    metrics.cost_micros,
    metrics.impressions,
    metrics.clicks,
    metrics.conversions,
    metrics.conversions_value,
    segments.date
  FROM campaign
  WHERE segments.date DURING LAST_90_DAYS
`;

function yesterdayISO(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function reportGaqlForDay(day: string): string {
  return `
    SELECT
      campaign.id,
      metrics.cost_micros,
      metrics.impressions,
      metrics.clicks,
      metrics.conversions,
      metrics.conversions_value,
      segments.date
    FROM campaign
    WHERE segments.date = '${day}'
  `;
}

async function insertRawPoll(
  shopId: string,
  pollKind: string,
  payload: unknown,
  sb: SupabaseClient,
): Promise<void> {
  const { error } = await sb.from("raw_google_poll").insert({
    shop_id: shopId,
    poll_kind: pollKind,
    payload,
    polled_at: new Date().toISOString(),
  });
  if (error) throw error;
}

/** Build a ShopAdSource over a GoogleAdsClient (campaigns + spend, normalized). */
export function googleSource(
  client: GoogleAdsClient,
  shopId: string,
  sb: SupabaseClient,
): ShopAdSource {
  return {
    async fetchCampaigns() {
      const raw = await client.search(CAMPAIGN_GAQL);
      await insertRawPoll(shopId, "campaigns", { data: raw }, sb);
      return (raw as GoogleCampaignPayload[]).map((r) => transformCampaign(r, shopId));
    },
    async fetchBackfillSpend() {
      const raw = await client.search(REPORT_GAQL_90D);
      await insertRawPoll(shopId, "report", { data: raw }, sb);
      return (raw as GoogleReportRow[]).map((r) => transformReportRow(r, shopId));
    },
    async fetchDailySpend(day: string) {
      const raw = await client.search(reportGaqlForDay(day));
      await insertRawPoll(shopId, "report", { data: raw, day }, sb);
      return (raw as GoogleReportRow[]).map((r) => transformReportRow(r, shopId));
    },
  };
}

async function recordSyncError(shopId: string, err: unknown, sb: SupabaseClient): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const now = new Date().toISOString();
  await sb
    .from("shop_integrations")
    .update({ sync_status: "error", sync_error: message.slice(0, 500), updated_at: now })
    .eq("shop_id", shopId)
    .eq("kind", "google_ads");
}

/**
 * Backfill the last 90 days of campaigns + per-day metrics for one shop.
 * Sets sync_status='live' on success.
 */
export async function backfillGoogle(
  client: GoogleAdsClient,
  shopId: string,
  sb: SupabaseClient,
): Promise<void> {
  try {
    await backfillAds(googleSource(client, shopId, sb), "google", shopId, sb);
    const now = new Date().toISOString();
    const { error } = await sb
      .from("shop_integrations")
      .update({ sync_status: "live", sync_error: null, last_sync_at: now, updated_at: now })
      .eq("shop_id", shopId)
      .eq("kind", "google_ads");
    if (error) throw error;
  } catch (err) {
    await recordSyncError(shopId, err, sb);
    throw err;
  }
}

/**
 * Re-fetch yesterday's metrics + current campaign state for one shop. Same
 * upsert logic as backfill, scoped to YESTERDAY only.
 */
export async function pollGoogleDaily(
  client: GoogleAdsClient,
  shopId: string,
  sb: SupabaseClient,
): Promise<void> {
  try {
    await pollAdsDaily(googleSource(client, shopId, sb), "google", shopId, sb);
    const now = new Date().toISOString();
    const { error } = await sb
      .from("shop_integrations")
      .update({ sync_error: null, last_sync_at: now, updated_at: now })
      .eq("shop_id", shopId)
      .eq("kind", "google_ads");
    if (error) throw error;
  } catch (err) {
    await recordSyncError(shopId, err, sb);
    throw err;
  }
}
