// Generic, platform-blind ad ingestion. The extracted core of the original
// google/ingest.server.ts: upsert campaign dims, then resolve spend rows to
// campaign UUIDs via ONE batched `in` lookup (scoped to the platform) and upsert
// facts. Unknown campaigns are skipped with a warning, never thrown (rule 12:
// surfaced, not silent). Source I/O + sync_status bookkeeping live in the
// per-platform adapters and the cron, not here.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { NormalizedCampaign, NormalizedSpendRow, Platform, ShopAdSource } from "./adapter";

function yesterdayISO(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function upsertCampaigns(
  campaigns: NormalizedCampaign[],
  sb: SupabaseClient,
): Promise<void> {
  const dims = campaigns
    .filter((c) => c.external_id)
    .map((c) => ({
      shop_id: c.shop_id,
      platform: c.platform,
      external_id: c.external_id,
      name: c.name,
      status: c.status,
      objective: c.objective,
      daily_budget_cents: c.daily_budget_cents,
      currency: c.currency,
      geo_targets: c.geo_targets,
      created_at_source: c.created_at_source,
      last_synced_at: new Date().toISOString(),
    }));
  if (!dims.length) return;
  const { error } = await sb
    .from("ad_campaign_dim")
    .upsert(dims, { onConflict: "shop_id,platform,external_id" });
  if (error) throw error;
}

async function upsertSpendFacts(
  rows: NormalizedSpendRow[],
  shopId: string,
  platform: Platform,
  sb: SupabaseClient,
): Promise<void> {
  const externalIds = new Set<string>();
  for (const r of rows) if (r.campaign_external_id) externalIds.add(r.campaign_external_id);
  if (externalIds.size === 0) return;

  // Single-batch external_id -> uuid lookup, scoped to this platform. Without
  // this, every spend row would issue its own SELECT.
  const { data: idRows, error: idErr } = await sb
    .from("ad_campaign_dim")
    .select("id, external_id")
    .eq("shop_id", shopId)
    .eq("platform", platform)
    .in("external_id", [...externalIds]);
  if (idErr) throw idErr;
  const idMap = new Map<string, string>(
    (idRows ?? []).map((r) => [r.external_id as string, r.id as string]),
  );

  const now = new Date().toISOString();
  const factRows: Array<Record<string, unknown>> = [];
  for (const r of rows) {
    if (!r.campaign_external_id || !r.day) continue;
    const uuid = idMap.get(r.campaign_external_id);
    if (!uuid) {
      console.warn(
        `[ads.ingest] ${platform} spend references unknown campaign ${r.campaign_external_id} for shop ${shopId}, skipping`,
      );
      continue;
    }
    factRows.push({
      shop_id: shopId,
      campaign_id: uuid,
      day: r.day,
      spend_cents: r.spend_cents,
      impressions: r.impressions,
      clicks: r.clicks,
      conversions: r.conversions,
      revenue_attrib_cents: r.revenue_attrib_cents,
      polled_at: now,
    });
  }
  if (!factRows.length) return;
  const { error } = await sb
    .from("ad_spend_fact")
    .upsert(factRows, { onConflict: "campaign_id,day" });
  if (error) throw error;
}

/** Backfill: full campaign list + trailing-window spend for one shop+platform. */
export async function backfillAds(
  source: ShopAdSource,
  platform: Platform,
  shopId: string,
  sb: SupabaseClient,
): Promise<void> {
  await upsertCampaigns(await source.fetchCampaigns(), sb);
  await upsertSpendFacts(await source.fetchBackfillSpend(), shopId, platform, sb);
}

/** Daily poll: refresh campaign state + yesterday's spend for one shop+platform. */
export async function pollAdsDaily(
  source: ShopAdSource,
  platform: Platform,
  shopId: string,
  sb: SupabaseClient,
): Promise<void> {
  await upsertCampaigns(await source.fetchCampaigns(), sb);
  const day = yesterdayISO();
  await upsertSpendFacts(await source.fetchDailySpend(day), shopId, platform, sb);
}
