// TikTok campaign actions. Status via /campaign/status/update/, budget via
// /campaign/update/ (budget in major currency units). An injected `call(path,
// body)` fn keeps the logic testable; the resolver builds the real call against
// the TikTok Business API using integration_credentials (kind tiktok_ads).

import { getSupabase } from "../supabase.server";
import { decrypt } from "../crypto.server";
import type { ActionAdapter, CampaignActionState } from "../ads/actions";
import { ActionError } from "../ads/actions";

type CallFn = (path: string, body: Record<string, unknown>) => Promise<{ code?: number; message?: string }>;

function check(r: { code?: number; message?: string }): void {
  if (r.code !== undefined && r.code !== 0) throw new ActionError("tiktok", r.message ?? `code ${r.code}`);
}

export function makeTikTokActionAdapter(call: CallFn, advertiserId: string): ActionAdapter {
  return {
    platform: "tiktok",
    async pause(externalId) {
      check(await call("/campaign/status/update/", {
        advertiser_id: advertiserId, campaign_ids: [externalId], operation_status: "DISABLE",
      }));
    },
    async resume(externalId) {
      check(await call("/campaign/status/update/", {
        advertiser_id: advertiserId, campaign_ids: [externalId], operation_status: "ENABLE",
      }));
    },
    async setDailyBudget(externalId, cents) {
      check(await call("/campaign/update/", {
        advertiser_id: advertiserId, campaign_id: externalId, budget: Math.round(cents) / 100,
      }));
    },
    async getState(): Promise<CampaignActionState> {
      // Slice 3 records pre-state from ad_campaign_dim (see executor); TikTok's
      // per-campaign read endpoint is not needed for the action path.
      throw new ActionError("tiktok", "getState not used for tiktok in Slice 3");
    },
    // Geo exclusion on TikTok lives on ad-group location targeting, requiring a
    // fan-out over the campaign's ad groups — built in Phase 2. Until then fail
    // terminally (no phantom). Demo shops use showcaseActionAdapter, not this.
    async excludeGeo() {
      throw new ActionError("tiktok", "geo exclusion not yet supported on tiktok", { retriable: false });
    },
    async includeGeo() {
      throw new ActionError("tiktok", "geo exclusion not yet supported on tiktok", { retriable: false });
    },
  };
}

/** Resolve a TikTok action adapter for a shop, or null if not connected. */
export async function tiktokActionAdapterForShop(shopId: string): Promise<ActionAdapter | null> {
  const { data, error } = await getSupabase()
    .from("integration_credentials")
    .select("access_token_encrypted, external_account_id")
    .eq("shop_id", shopId)
    .eq("kind", "tiktok_ads")
    .maybeSingle();
  if (error) throw error;
  if (!data || !data.access_token_encrypted || !data.external_account_id) return null;
  const token = decrypt(data.access_token_encrypted as string);
  const advertiserId = String(data.external_account_id);
  const base = "https://business-api.tiktok.com/open_api/v1.3";

  const call: CallFn = async (path, body) => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Access-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as { code?: number; message?: string };
  };
  return makeTikTokActionAdapter(call, advertiserId);
}
