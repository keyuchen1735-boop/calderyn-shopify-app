// Reverse-lookup: (shop, platform, external_id) -> ad_campaign_dim.id (uuid).
// The Campaigns route loads campaigns from the live platform API, where the id is
// the platform's external id, but executeAction keys off the dim uuid. This
// bridges the two using the same scoped select pattern as ads/ingest.server.ts.
// Returns null when the campaign has not yet been ingested into ad_campaign_dim.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Platform } from "./adapter";

export async function resolveCampaignDimId(
  sb: SupabaseClient,
  shopId: string,
  platform: Platform,
  externalId: string,
): Promise<string | null> {
  const { data, error } = await sb
    .from("ad_campaign_dim")
    .select("id")
    .eq("shop_id", shopId)
    .eq("platform", platform)
    .eq("external_id", externalId)
    .maybeSingle();
  if (error) throw error;
  return data ? String(data.id) : null;
}
