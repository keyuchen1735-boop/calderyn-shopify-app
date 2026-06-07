// Meta adapter: resolve creds by shop_id from integration_credentials (text
// token, crypto.server.ts), build a MetaClient, expose a ShopAdSource.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "../supabase.server";
import { decrypt } from "../crypto.server";
import { listCampaigns, type MetaClient, type MetaResponse } from "./campaigns.server";
import { metaCampaignToNormalized } from "./transform";
import { fetchMetaInsights, assertNotRateLimited } from "./insights.server";
import type { AdPlatformAdapter, ShopAdSource } from "../ads/adapter";
import { withRetry } from "../ads/backoff";

const GRAPH_VERSION = "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const RETRY = { maxAttempts: 4, baseDelayMs: 500 };

// Re-export for direct unit testing.
export { fetchMetaInsights };

/** Default account currency when the account row doesn't carry one. */
const DEFAULT_CURRENCY = "USD";

export function makeMetaSource(
  client: MetaClient,
  adAccountId: string,
  shopId: string,
  currency: string,
): ShopAdSource {
  return {
    async fetchCampaigns() {
      const camps = await withRetry(() => listCampaigns(client, adAccountId), RETRY);
      return camps.map((c) => metaCampaignToNormalized(c, shopId, currency));
    },
    async fetchBackfillSpend() {
      return withRetry(() => fetchMetaInsights(client, adAccountId, shopId, { datePreset: "last_90d" }), RETRY);
    },
    async fetchDailySpend(day: string) {
      return withRetry(() => fetchMetaInsights(client, adAccountId, shopId, { day }), RETRY);
    },
  };
}

function buildClient(token: string): MetaClient {
  return {
    async get(path, params = {}) {
      const qs = new URLSearchParams({ ...params, access_token: token }).toString();
      const res = await fetch(`${GRAPH_BASE}${path}?${qs}`);
      if (res.status === 429) {
        // surfaced as a Meta error code path via the response body; map here too
        return { error: { message: "HTTP 429", code: 4 } } as MetaResponse;
      }
      return (await res.json()) as MetaResponse;
    },
    async post(path, body) {
      const form = new URLSearchParams({ ...body, access_token: token });
      const res = await fetch(`${GRAPH_BASE}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      return (await res.json()) as MetaResponse;
    },
  };
}

export const metaAdapter: AdPlatformAdapter = {
  platform: "meta",
  integrationKind: "meta_ads",
  async connect(shopId: string): Promise<ShopAdSource | null> {
    const sb: SupabaseClient = getSupabase();
    const { data, error } = await sb
      .from("integration_credentials")
      .select("access_token_encrypted, external_account_id")
      .eq("shop_id", shopId)
      .eq("kind", "meta_ads")
      .maybeSingle();
    if (error) throw error;
    if (!data || !data.access_token_encrypted || !data.external_account_id) return null;
    const token = decrypt(data.access_token_encrypted as string);
    const adAccountId = String(data.external_account_id);
    const builtClient = buildClient(token);
    const acct = assertNotRateLimited(await builtClient.get(`/${adAccountId}`, { fields: "currency" }));
    const currency =
      typeof (acct as { currency?: unknown }).currency === "string"
        ? (acct as { currency: string }).currency
        : DEFAULT_CURRENCY;
    return makeMetaSource(builtClient, adAccountId, shopId, currency);
  },
};
