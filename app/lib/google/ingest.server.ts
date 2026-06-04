// Google Ads ingestion: 90-day backfill + daily poll.
//
// Mirrors the monorepo worker logic, but built on this repo's conventions:
// the GoogleAdsClient and a Supabase instance are passed in (like the meta
// funcs take a MetaClient) so these are unit-testable with fakes. Writes go
// through the Supabase PostgREST client with onConflict upserts.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { GoogleAdsClient } from "./client.server";
import {
  transformCampaign,
  transformReportRow,
} from "./transform";
import type { GoogleCampaignPayload, GoogleReportRow } from "./types";

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

/** Upsert campaign dim rows from raw campaign payloads. */
async function upsertCampaigns(
  rawRows: unknown[],
  shopId: string,
  sb: SupabaseClient,
): Promise<void> {
  const dims = (rawRows as GoogleCampaignPayload[])
    .map((raw) => transformCampaign(raw, shopId))
    .filter((d) => d.external_id)
    .map((d) => ({
      shop_id: d.shop_id,
      platform: d.platform,
      external_id: d.external_id,
      name: d.name,
      status: d.status,
      objective: d.objective,
      daily_budget_cents: d.daily_budget_cents,
      currency: d.currency,
      geo_targets: d.geo_targets,
      created_at_source: d.created_at_source,
      last_synced_at: new Date().toISOString(),
    }));
  if (!dims.length) return;
  const { error } = await sb
    .from("ad_campaign_dim")
    .upsert(dims, { onConflict: "shop_id,platform,external_id" });
  if (error) throw error;
}

/**
 * Resolve report rows to campaign uuids and upsert spend facts. Uses a single
 * batched `in` lookup (NOT one query per row). Report rows referencing unknown
 * campaigns are skipped with a warning — never thrown.
 */
async function upsertSpendFacts(
  rawRows: unknown[],
  shopId: string,
  sb: SupabaseClient,
): Promise<void> {
  const facts = (rawRows as GoogleReportRow[]).map((raw) => transformReportRow(raw, shopId));

  const externalIds = new Set<string>();
  for (const f of facts) {
    if (f.campaign_external_id) externalIds.add(f.campaign_external_id);
  }
  if (externalIds.size === 0) return;

  // Single-batch external_id -> uuid lookup. Without this, every report row
  // would issue its own SELECT — pathological for accounts with thousands of
  // campaigns x 90 days of rows.
  const { data: idRows, error: idErr } = await sb
    .from("ad_campaign_dim")
    .select("id, external_id")
    .eq("shop_id", shopId)
    .eq("platform", "google")
    .in("external_id", [...externalIds]);
  if (idErr) throw idErr;
  const campaignIdMap = new Map<string, string>(
    (idRows ?? []).map((r) => [r.external_id as string, r.id as string]),
  );

  const factRows: Array<{
    shop_id: string;
    campaign_id: string;
    day: string;
    spend_cents: number;
    impressions: number;
    clicks: number;
    conversions: number;
    revenue_attrib_cents: number;
    polled_at: string;
  }> = [];
  const now = new Date().toISOString();
  for (const f of facts) {
    if (!f.campaign_external_id || !f.day) continue;
    const campaignUuid = campaignIdMap.get(f.campaign_external_id);
    if (!campaignUuid) {
      // Skip, do NOT throw: a report row may reference a campaign that the
      // campaign query did not return (e.g. since-removed). Surface it.
      console.warn(
        `[google.ingest] report references unknown campaign ${f.campaign_external_id} for shop ${shopId}, skipping`,
      );
      continue;
    }
    factRows.push({
      shop_id: shopId,
      campaign_id: campaignUuid,
      day: f.day,
      spend_cents: f.spend_cents,
      impressions: f.impressions,
      clicks: f.clicks,
      conversions: f.conversions,
      revenue_attrib_cents: f.revenue_attrib_cents,
      polled_at: now,
    });
  }
  if (!factRows.length) return;
  const { error } = await sb
    .from("ad_spend_fact")
    .upsert(factRows, { onConflict: "campaign_id,day" });
  if (error) throw error;
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
    const campaignRows = await client.search(CAMPAIGN_GAQL);
    await insertRawPoll(shopId, "campaigns", { data: campaignRows }, sb);
    await upsertCampaigns(campaignRows, shopId, sb);

    const reportRows = await client.search(REPORT_GAQL_90D);
    await insertRawPoll(shopId, "report", { data: reportRows }, sb);
    await upsertSpendFacts(reportRows, shopId, sb);

    const now = new Date().toISOString();
    const { error } = await sb
      .from("shop_integrations")
      .update({ sync_status: "live", sync_error: null, last_sync_at: now, updated_at: now })
      .eq("shop_id", shopId)
      .eq("kind", "google_ads");
    if (error) throw error;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const now = new Date().toISOString();
    await sb
      .from("shop_integrations")
      .update({ sync_status: "error", sync_error: message.slice(0, 500), updated_at: now })
      .eq("shop_id", shopId)
      .eq("kind", "google_ads");
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
    const campaignRows = await client.search(CAMPAIGN_GAQL);
    await upsertCampaigns(campaignRows, shopId, sb);

    const day = yesterdayISO();
    const reportRows = await client.search(reportGaqlForDay(day));
    await insertRawPoll(shopId, "report", { data: reportRows, day }, sb);
    await upsertSpendFacts(reportRows, shopId, sb);

    const now = new Date().toISOString();
    const { error } = await sb
      .from("shop_integrations")
      .update({ sync_error: null, last_sync_at: now, updated_at: now })
      .eq("shop_id", shopId)
      .eq("kind", "google_ads");
    if (error) throw error;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const now = new Date().toISOString();
    await sb
      .from("shop_integrations")
      .update({ sync_status: "error", sync_error: message.slice(0, 500), updated_at: now })
      .eq("shop_id", shopId)
      .eq("kind", "google_ads");
    throw err;
  }
}
