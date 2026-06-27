// Google Ads campaign actions. Mutations go through an injected `mutate(resource,
// operation, campaignExternalId?)` fn so the logic is unit-testable; the resolver
// builds the real mutate against the Google Ads REST API using the shop's
// integration_credentials (kind google_ads). Money is micros (cents * 10_000).

import { getSupabase } from "../supabase.server";
import { decrypt } from "../crypto.server";
import type { ActionAdapter, CampaignActionState } from "../ads/actions";
import { ActionError } from "../ads/actions";
import { googleGeoTargetConstants } from "../ads/geo-regions";
import { extractAdsError } from "./client.server";

type MutateFn = (resource: string, operation: Record<string, unknown>, campaignExternalId?: string) => Promise<unknown>;
type ReadFn = (campaignExternalId: string) => Promise<{ status?: string; amountMicros?: number }>;
/** Reads the campaign's existing NEGATIVE location criteria (for include/undo). */
type SearchCriteriaFn = (
  campaignExternalId: string,
) => Promise<Array<{ resourceName: string; geoTargetConstant: string }>>;

const CENTS_TO_MICROS = 10_000;

export function makeGoogleActionAdapter(
  mutate: MutateFn,
  customerId: string,
  read?: ReadFn,
  searchCriteria?: SearchCriteriaFn,
): ActionAdapter {
  const setStatus = (externalId: string, status: "ENABLED" | "PAUSED") =>
    mutate("campaigns", {
      update: { resourceName: `customers/${customerId}/campaigns/${externalId}`, status },
      updateMask: "status",
    });
  return {
    platform: "google",
    async pause(externalId) {
      await setStatus(externalId, "PAUSED");
    },
    async resume(externalId) {
      await setStatus(externalId, "ENABLED");
    },
    async setDailyBudget(externalId, cents) {
      await mutate(
        "campaignBudgets",
        { update: { amountMicros: cents * CENTS_TO_MICROS }, updateMask: "amount_micros" },
        externalId,
      );
    },
    async getState(externalId): Promise<CampaignActionState> {
      if (!read) throw new ActionError("google", "getState reader not configured");
      const r = await read(externalId);
      return {
        status: (r.status ?? "").toUpperCase() === "PAUSED" ? "paused" : "active",
        dailyBudgetCents: r.amountMicros != null ? Math.round(r.amountMicros / CENTS_TO_MICROS) : null,
      };
    },
    async excludeGeo(externalId, region) {
      // One negative campaign-criterion per state in the region. Campaign-level
      // criteria are the campaign-scoped equivalent of an ad-set exclusion.
      for (const geo of googleGeoTargetConstants(region)) {
        await mutate("campaignCriteria", {
          create: {
            campaign: `customers/${customerId}/campaigns/${externalId}`,
            negative: true,
            location: { geoTargetConstant: geo },
          },
        });
      }
    },
    async includeGeo(externalId, region) {
      if (!searchCriteria) throw new ActionError("google", "includeGeo reader not configured");
      const wanted = new Set(googleGeoTargetConstants(region));
      const existing = await searchCriteria(externalId);
      for (const row of existing) {
        if (wanted.has(row.geoTargetConstant)) {
          await mutate("campaignCriteria", { remove: row.resourceName });
        }
      }
    },
  };
}

/** Resolve a Google action adapter for a shop, or null if not connected. */
export async function googleActionAdapterForShop(shopId: string): Promise<ActionAdapter | null> {
  const { data, error } = await getSupabase()
    .from("integration_credentials")
    .select("access_token_encrypted, external_account_id")
    .eq("shop_id", shopId)
    .eq("kind", "google_ads")
    .maybeSingle();
  if (error) throw error;
  if (!data || !data.access_token_encrypted || !data.external_account_id) return null;
  const refreshToken = decrypt(data.access_token_encrypted as string);
  const customerId = String(data.external_account_id);

  const apiVersion = "v23";
  const base = `https://googleads.googleapis.com/${apiVersion}`;
  const devToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (!devToken) throw new ActionError("google", "GOOGLE_ADS_DEVELOPER_TOKEN must be set");

  async function accessToken(): Promise<string> {
    const clientId = process.env.GOOGLE_ADS_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new ActionError("google", "Google OAuth client env not set");
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token",
      }).toString(),
    });
    const json = (await res.json()) as { access_token?: string; error_description?: string };
    if (!json.access_token) throw new ActionError("google", `token exchange failed: ${json.error_description ?? "no token"}`);
    return json.access_token;
  }

  const search = async (query: string): Promise<unknown> => {
    const token = await accessToken();
    const res = await fetch(`${base}/customers/${customerId}/googleAds:search`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "developer-token": devToken, "content-type": "application/json" },
      body: JSON.stringify({ query }),
    });
    const json: unknown = await res.json();
    const errMessage = extractAdsError(json);
    if (!res.ok || errMessage) throw new ActionError("google", errMessage ?? `HTTP ${res.status}`);
    return json;
  };

  // A campaign's budget is its own resource (customers/N/campaignBudgets/M) and
  // a mutate update without that resourceName is rejected by the API — so budget
  // edits must first resolve campaign → campaignBudget. Campaign mutates carry
  // their resourceName already and skip this.
  const budgetResourceFor = async (campaignExternalId: string): Promise<string> => {
    if (!/^\d+$/.test(campaignExternalId)) {
      throw new ActionError("google", `invalid campaign id: ${campaignExternalId}`);
    }
    const json = await search(
      `SELECT campaign.campaign_budget FROM campaign WHERE campaign.id = ${campaignExternalId}`,
    );
    const resource = (json as { results?: Array<{ campaign?: { campaignBudget?: string } }> })
      .results?.[0]?.campaign?.campaignBudget;
    if (!resource) {
      throw new ActionError("google", `no campaign budget found for campaign ${campaignExternalId}`);
    }
    return resource;
  };

  const mutate: MutateFn = async (resource, operation, campaignExternalId) => {
    let op = operation;
    if (resource === "campaignBudgets" && campaignExternalId) {
      const update = (op.update ?? {}) as Record<string, unknown>;
      if (!update.resourceName) {
        op = { ...op, update: { ...update, resourceName: await budgetResourceFor(campaignExternalId) } };
      }
    }
    const token = await accessToken();
    const res = await fetch(`${base}/customers/${customerId}/${resource}:mutate`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "developer-token": devToken, "content-type": "application/json" },
      body: JSON.stringify({ operations: [op] }),
    });
    // extractAdsError appends error.details[].errors[] (rule 12): a bare
    // "The caller does not have permission" is not actionable.
    const json: unknown = await res.json();
    const errMessage = extractAdsError(json);
    if (!res.ok || errMessage) throw new ActionError("google", errMessage ?? `HTTP ${res.status}`);
    return json;
  };

  // Read the campaign's existing NEGATIVE location criteria so includeGeo (undo)
  // can find the exact resource names to remove.
  const searchCriteria: SearchCriteriaFn = async (campaignExternalId) => {
    if (!/^\d+$/.test(campaignExternalId)) {
      throw new ActionError("google", `invalid campaign id: ${campaignExternalId}`);
    }
    const json = (await search(
      `SELECT campaign_criterion.resource_name, campaign_criterion.location.geo_target_constant
       FROM campaign_criterion
       WHERE campaign.id = ${campaignExternalId}
         AND campaign_criterion.negative = true
         AND campaign_criterion.type = LOCATION`,
    )) as {
      results?: Array<{
        campaignCriterion?: { resourceName?: string; location?: { geoTargetConstant?: string } };
      }>;
    };
    return (json.results ?? []).map((r) => ({
      resourceName: String(r.campaignCriterion?.resourceName ?? ""),
      geoTargetConstant: String(r.campaignCriterion?.location?.geoTargetConstant ?? ""),
    }));
  };

  return makeGoogleActionAdapter(mutate, customerId, undefined, searchCriteria);
}
