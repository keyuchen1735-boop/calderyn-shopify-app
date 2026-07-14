// Create a PAUSED "draft" ad on Meta and delete it again (for undo). Writes go
// through the retriable-aware `check` + `withRetry` so brief throttles back off
// and Meta-permanent errors (token/permission) fail terminally — the executor's
// try/catch then classifies via isRetriableFailure. The MetaClient is injected
// so tests pass a fake post/get (mirrors meta/__tests__/campaigns.test.ts).

import { getSupabase } from "../supabase.server";
import { decrypt } from "../crypto.server";
import { ActionError } from "../ads/actions";
import { withRetry, type RetryOptions } from "../ads/backoff";
import { assertNotRateLimited, type MetaClient, type MetaResponse } from "./campaigns.server";
import { throttleMetaClient } from "./throttle.server";
import { hasAdsManagementScope } from "../integration-status";
import type { CreativeInput } from "~/lib/screener/types";
import type { SupabaseClient } from "@supabase/supabase-js";

const GRAPH_VERSION = "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const DEFAULT_RETRY: RetryOptions = { maxAttempts: 4, baseDelayMs: 500 };

// Mirrors the canonical list in meta/actions.server.ts. That module's `check` is
// NOT exported, so this write module keeps its own retriable-aware copy by repo
// convention (campaigns.server + actions.server already each define their own).
const META_PERMANENT_CODES = new Set([100, 190, 200, 10, 803, 272]);

function check(r: MetaResponse, step: string): MetaResponse {
  assertNotRateLimited(r);
  if (r.error) {
    const code = r.error.code;
    // Include subcode + error_user_msg when Meta sends them — they carry the
    // actually-actionable reason, and the step label says which of the flow's
    // Meta writes rejected (mirrors campaign-create.server.ts).
    const codeStr =
      code != null
        ? ` (code ${code}${r.error.error_subcode != null ? `/${r.error.error_subcode}` : ""})`
        : "";
    const userMsg = r.error.error_user_msg ? ` — ${r.error.error_user_msg}` : "";
    throw new ActionError("meta", `${step}: ${r.error.message}${codeStr}${userMsg}`, {
      retriable: !(code != null && META_PERMANENT_CODES.has(code)),
    });
  }
  return r;
}

export interface MetaWriteConn {
  client: MetaClient;
  adAccountId: string; // "act_<id>"
}

/** First usable Facebook Page for the ad account; required for object_story_spec.
 *  Not stored anywhere today, so resolved live. Fails loudly when none exists. */
async function resolvePageId(client: MetaClient, adAccountId: string): Promise<string> {
  const body = check(await client.get(`/${adAccountId}/promote_pages`, { fields: "id" }), "page lookup");
  const page = ((body.data as Array<{ id?: string }>) ?? [])[0];
  const pageId = page?.id ? String(page.id) : "";
  if (!pageId) {
    throw new Error("Meta ad account has no Facebook Page to attach the creative; reconnect Meta with a Page selected");
  }
  return pageId;
}

/**
 * Create a draft ad: POST /{adAccountId}/adcreatives, then POST /{adSetId}/ads.
 * The ad's status is caller-controlled via `args.status` and defaults to PAUSED
 * (the push-creative-draft path relies on that default). Returns the new ad id
 * for undo. Signature matches the locked contract:
 * (client, { adAccountId, adSetId, creative }), with `status` an optional add-on.
 */
export async function createPausedAd(
  client: MetaClient,
  args: { adAccountId: string; adSetId: string; creative: CreativeInput; status?: "ACTIVE" | "PAUSED" },
): Promise<{ adId: string }> {
  const { adAccountId, adSetId, creative, status = "PAUSED" } = args;
  const pageId = await resolvePageId(client, adAccountId);
  const cta = creative.cta || "SHOP_NOW";

  const linkData: Record<string, unknown> = {
    message: creative.primaryText,
    link: creative.destinationUrl,
    name: creative.headline,
    call_to_action: { type: cta, value: { link: creative.destinationUrl } },
  };
  if (creative.imageUrl) linkData.picture = creative.imageUrl;
  const objectStorySpec = JSON.stringify({ page_id: pageId, link_data: linkData });

  const creativeRes = await withRetry(
    async () =>
      check(
        await client.post(`/${adAccountId}/adcreatives`, {
          name: creative.headline || "Calderyn draft creative",
          object_story_spec: objectStorySpec,
        }),
        "creative create",
      ),
    DEFAULT_RETRY,
  );
  const creativeId = String((creativeRes as { id?: unknown }).id ?? "");
  if (!creativeId) throw new Error("Meta did not return a creative id");

  const adRes = await withRetry(
    async () =>
      check(
        await client.post(`/${adSetId}/ads`, {
          name: creative.headline || "Calderyn draft ad",
          adset_id: adSetId,
          creative: JSON.stringify({ creative_id: creativeId }),
          status,
        }),
        "ad create",
      ),
    DEFAULT_RETRY,
  );
  const adId = String((adRes as { id?: unknown }).id ?? "");
  if (!adId) throw new Error("Meta did not return an ad id");
  return { adId };
}

/** Delete a draft ad for undo. MetaClient has no DELETE verb, so we set the
 *  writable configured status to DELETED — the ad leaves the active account set. */
export async function deleteAd(client: MetaClient, adId: string): Promise<void> {
  await withRetry(async () => {
    check(await client.post(`/${adId}`, { status: "DELETED" }), "ad delete");
  }, DEFAULT_RETRY);
}

/** Resolve a Meta write client by shopId (the executor only has shopId, not the
 *  shop domain). Mirrors metaActionAdapterForShop's cred lookup. */
export async function metaWriteClientForShopId(shopId: string): Promise<MetaWriteConn | null> {
  const { data, error } = await getSupabase()
    .from("integration_credentials")
    .select("access_token_encrypted, external_account_id")
    .eq("shop_id", shopId)
    .eq("kind", "meta_ads")
    .maybeSingle();
  if (error) throw error;
  if (!data || !data.access_token_encrypted) return null;
  const token = decrypt(data.access_token_encrypted as string);
  const adAccountId = (data.external_account_id as string | null) ?? "";
  if (!adAccountId) return null;
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
  return { client: throttleMetaClient(client, shopId), adAccountId };
}

/** True when the stored Meta token carries ads_management (required to create
 *  ads). DI'd sb for tests. Read failure / missing scopes ⇒ false (no false-enable). */
export async function metaDraftPushEnabled(sb: SupabaseClient, shopId: string): Promise<boolean> {
  const { data, error } = await sb
    .from("integration_credentials")
    .select("scopes")
    .eq("shop_id", shopId)
    .eq("kind", "meta_ads")
    .maybeSingle();
  if (error) return false;
  return hasAdsManagementScope((data?.scopes as string | null) ?? null);
}
