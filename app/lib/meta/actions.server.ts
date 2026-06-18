// Meta campaign actions over a MetaClient. pause/resume post campaign status;
// budget posts daily_budget (account minor units, as a string per the Graph API).

import { getSupabase } from "../supabase.server";
import { decrypt } from "../crypto.server";
import type { ActionAdapter, CampaignActionState } from "../ads/actions";
import { ActionError } from "../ads/actions";
import { withRetry, type RetryOptions } from "../ads/backoff";
import { assertNotRateLimited, type MetaClient, type MetaResponse } from "./campaigns.server";
import { throttleMetaClient } from "./throttle.server";

const GRAPH_VERSION = "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

// In-process absorption of brief Graph throttles (code 80004 etc.), matching
// the ingest adapter's policy. A call still throttled after the cap surfaces
// RateLimitError, which isRetriableFailure treats as transient — the executor
// parks the action `retrying` for the action-retry cron instead of failing.
const DEFAULT_RETRY: RetryOptions = { maxAttempts: 4, baseDelayMs: 500 };

// Graph API top-level error codes that are PERMANENT for a write action — the
// target object is gone (100), the access token is dead (190), or the app/user
// lacks permission (200/10/803/272). Parking these as `retrying` burns the
// action-retry budget against an action that can never succeed AND surfaces a
// not-yet-failed result the dashboard reports as a false success (P0-1). Fail
// them terminally; every other Graph error stays default-retriable so a
// transient blip doesn't lose the recovery (rate-limit codes are handled by
// assertNotRateLimited first).
const META_PERMANENT_CODES = new Set([100, 190, 200, 10, 803, 272]);

function check(r: MetaResponse): MetaResponse {
  assertNotRateLimited(r);
  if (r.error) {
    const code = r.error.code;
    const codeStr = code != null ? ` (code ${code})` : "";
    throw new ActionError("meta", `${r.error.message}${codeStr}`, {
      retriable: !(code != null && META_PERMANENT_CODES.has(code)),
    });
  }
  return r;
}

export function makeMetaActionAdapter(client: MetaClient, retry: RetryOptions = DEFAULT_RETRY): ActionAdapter {
  return {
    platform: "meta",
    async pause(externalId) {
      await withRetry(async () => {
        check(await client.post(`/${externalId}`, { status: "PAUSED" }));
      }, retry);
    },
    async resume(externalId) {
      await withRetry(async () => {
        check(await client.post(`/${externalId}`, { status: "ACTIVE" }));
      }, retry);
    },
    async setDailyBudget(externalId, cents) {
      await withRetry(async () => {
        check(await client.post(`/${externalId}`, { daily_budget: String(cents) }));
      }, retry);
    },
    async getState(externalId): Promise<CampaignActionState> {
      const body = await withRetry(
        async () => check(await client.get(`/${externalId}`, { fields: "status,daily_budget" })),
        retry,
      );
      const raw = body as { status?: string; daily_budget?: string };
      return {
        status: (raw.status ?? "").toUpperCase() === "PAUSED" ? "paused" : "active",
        dailyBudgetCents: raw.daily_budget != null ? Number(raw.daily_budget) : null,
      };
    },
  };
}

/** Resolve a Meta action adapter for a shop, or null if not connected. */
export async function metaActionAdapterForShop(
  shopId: string,
  retry?: RetryOptions,
): Promise<ActionAdapter | null> {
  const { data, error } = await getSupabase()
    .from("integration_credentials")
    .select("access_token_encrypted, external_account_id")
    .eq("shop_id", shopId)
    .eq("kind", "meta_ads")
    .maybeSingle();
  if (error) throw error;
  if (!data || !data.access_token_encrypted) return null;
  const token = decrypt(data.access_token_encrypted as string);
  const client: MetaClient = {
    async get(path, params = {}) {
      const qs = new URLSearchParams({ ...params, access_token: token }).toString();
      return (await fetch(`${GRAPH_BASE}${path}?${qs}`).then((r) => r.json())) as MetaResponse;
    },
    async post(path, body) {
      const form = new URLSearchParams({ ...body, access_token: token });
      return (await fetch(`${GRAPH_BASE}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }).then((r) => r.json())) as MetaResponse;
    },
  };
  return makeMetaActionAdapter(throttleMetaClient(client, shopId), retry);
}
