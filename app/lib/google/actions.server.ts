// Google Ads campaign actions. Mutations go through an injected `mutate(resource,
// operation, campaignExternalId?)` fn so the logic is unit-testable; the resolver
// builds the real mutate against the Google Ads REST API using the shop's
// integration_credentials (kind google_ads). Money is micros (cents * 10_000).

import { getSupabase } from "../supabase.server";
import { decrypt } from "../crypto.server";
import type { ActionAdapter, CampaignActionState } from "../ads/actions";
import { ActionError } from "../ads/actions";
import { extractAdsError } from "./client.server";

type MutateFn = (resource: string, operation: Record<string, unknown>, campaignExternalId?: string) => Promise<unknown>;
type ReadFn = (campaignExternalId: string) => Promise<{ status?: string; amountMicros?: number }>;

const CENTS_TO_MICROS = 10_000;

export function makeGoogleActionAdapter(mutate: MutateFn, customerId: string, read?: ReadFn): ActionAdapter {
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

  const mutate: MutateFn = async (resource, operation) => {
    const token = await accessToken();
    const res = await fetch(`${base}/customers/${customerId}/${resource}:mutate`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "developer-token": devToken, "content-type": "application/json" },
      body: JSON.stringify({ operations: [operation] }),
    });
    // extractAdsError appends error.details[].errors[] (rule 12): a bare
    // "The caller does not have permission" is not actionable.
    const json: unknown = await res.json();
    const errMessage = extractAdsError(json);
    if (!res.ok || errMessage) throw new ActionError("google", errMessage ?? `HTTP ${res.status}`);
    return json;
  };

  return makeGoogleActionAdapter(mutate, customerId);
}
