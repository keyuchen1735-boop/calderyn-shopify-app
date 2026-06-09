// TikTok adapter: creds from integration_credentials (kind tiktok_ads, text token
// via crypto.server.ts), advertiser_id from external_account_id. Exposes a
// ShopAdSource over a TikTokClient.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "../supabase.server";
import { decrypt } from "../crypto.server";
import { buildTikTokClient, type TikTokClient } from "./client.server";
import { tiktokCampaignToNormalized, tiktokReportToSpend } from "./transform";
import type { AdPlatformAdapter, ShopAdSource } from "../ads/adapter";
import { withRetry } from "../ads/backoff";

const RETRY = { maxAttempts: 4, baseDelayMs: 500 };

function daysAgoISO(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export function makeTikTokSource(
  client: TikTokClient,
  advertiserId: string,
  shopId: string,
  currency: string,
): ShopAdSource {
  return {
    async fetchCampaigns() {
      const camps = await withRetry(() => client.getCampaigns(advertiserId), RETRY);
      return camps.map((c) => tiktokCampaignToNormalized(c, shopId, currency));
    },
    async fetchBackfillSpend() {
      // TikTok caps report queries at 30 days; chunk the 90-day backfill.
      const all: Awaited<ReturnType<typeof client.getReport>> = [];
      for (let offset = 90; offset > 0; offset -= 30) {
        const start = daysAgoISO(offset);
        const end = daysAgoISO(Math.max(offset - 30, 0));
        const rows = await withRetry(() => client.getReport(advertiserId, start, end), RETRY);
        all.push(...rows);
      }
      return all.map((r) => tiktokReportToSpend(r, shopId));
    },
    async fetchDailySpend(day: string) {
      const rows = await withRetry(() => client.getReport(advertiserId, day, day), RETRY);
      return rows.map((r) => tiktokReportToSpend(r, shopId));
    },
  };
}

export const tiktokAdapter: AdPlatformAdapter = {
  platform: "tiktok",
  integrationKind: "tiktok_ads",
  async connect(shopId: string): Promise<ShopAdSource | null> {
    const sb: SupabaseClient = getSupabase();
    const { data, error } = await sb
      .from("integration_credentials")
      .select("access_token_encrypted, external_account_id")
      .eq("shop_id", shopId)
      .eq("kind", "tiktok_ads")
      .maybeSingle();
    if (error) throw error;
    if (!data || !data.access_token_encrypted || !data.external_account_id) return null;
    const token = decrypt(data.access_token_encrypted as string);
    const tiktokClient = buildTikTokClient(token);
    const advertiserId = String(data.external_account_id);
    const currency = await tiktokClient.getAdvertiserCurrency(advertiserId);
    return makeTikTokSource(tiktokClient, advertiserId, shopId, currency);
  },
};
