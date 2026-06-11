// app/lib/screener/meta-push.server.ts
// Push a screener variant to Meta as a PAUSED ad in the source ad's adset. Always
// paused, behind a UI confirm, audited + idempotent. Meta client is injected so
// tests never hit the network; the function returns an error DTO instead of
// throwing so failures surface in the in-app banner (rule 12).
import { getSupabase, resolveShopId } from "../supabase.server";
import { check, type MetaClient } from "../meta/campaigns.server";
import type { CreativeInput, CreativeScreenRun } from "./types";

/** Stable idempotency key so a re-push of the same variant never creates a duplicate. */
export function pushIdempotencyKey(runId: string, variantIndex: number): string {
  return `screener_push:${runId}:${variantIndex}`;
}

/**
 * Pure `/adcreatives` POST body. Uses `link_data.picture` (a URL) instead of an
 * image_hash, so it works for both copy variants (source image preserved) and
 * image variants (new asset URL) without uploading anything.
 */
export function buildCreativeParams(
  name: string,
  input: CreativeInput,
  pageId: string,
): Record<string, string> {
  const linkData: Record<string, unknown> = {
    message: input.primaryText,
    name: input.headline,
    link: input.destinationUrl,
    call_to_action: { type: input.cta, value: { link: input.destinationUrl } },
  };
  if (input.imageUrl) linkData.picture = input.imageUrl;
  return {
    name,
    object_story_spec: JSON.stringify({ page_id: pageId, link_data: linkData }),
  };
}

export interface PushResult {
  ok: boolean;
  adId: string | null;
  alreadyPushed: boolean;
  error: string | null;
}

export interface PushDeps {
  client: MetaClient;
  adAccountId: string;
}

function fail(error: string): PushResult {
  return { ok: false, adId: null, alreadyPushed: false, error };
}

/**
 * Push one variant to Meta as a PAUSED ad in the source ad's adset. Meta-sourced
 * runs only (the source ad supplies the adset + Page). Idempotent on
 * (run, variant) and audited via action_audit. Returns an error DTO instead of
 * throwing so failures show in the in-app banner.
 */
export async function pushVariantToMeta(
  args: { shop: string; run: CreativeScreenRun; variantIndex: number },
  deps: PushDeps,
): Promise<PushResult> {
  const { shop, run, variantIndex } = args;
  if (run.source !== "meta_ad" || !run.metaAdId) {
    return fail(
      "Only ads pulled from Meta can be pushed back — the source ad supplies the ad set and Page.",
    );
  }
  const variant = run.variants[variantIndex];
  if (!variant) return fail("That variant no longer exists. Re-generate and try again.");

  try {
    const sb = getSupabase();
    const shopId = await resolveShopId(shop);
    const key = pushIdempotencyKey(run.id, variantIndex);

    // Idempotency: a prior successful push wins — never create a duplicate ad.
    const prior = await sb
      .from("action_idempotency")
      .select("audit_id")
      .eq("shop_id", shopId)
      .eq("idempotency_key", key)
      .maybeSingle();
    const priorAuditId = (prior.data as { audit_id?: string } | null)?.audit_id;
    if (priorAuditId) {
      const aud = await sb
        .from("action_audit")
        .select("post_state")
        .eq("id", priorAuditId)
        .maybeSingle();
      const adId =
        (aud.data as { post_state?: { ad_id?: string } } | null)?.post_state?.ad_id ?? null;
      return { ok: true, adId, alreadyPushed: true, error: null };
    }

    // Source ad → adset + Facebook Page.
    const src = check(
      await deps.client.get(`/${run.metaAdId}`, {
        fields: "adset{id},creative{object_story_spec}",
      }),
    );
    const adsetId = (src as { adset?: { id?: string } }).adset?.id;
    const pageId = (src as { creative?: { object_story_spec?: { page_id?: string } } }).creative
      ?.object_story_spec?.page_id;
    if (!adsetId) return fail("Couldn't read the source ad's ad set.");
    if (!pageId) return fail("Couldn't read the source ad's Facebook Page.");

    const name = `Screener variant ${variantIndex + 1} — ${variant.input.headline}`.slice(0, 100);

    const creativeRes = check(
      await deps.client.post(
        `/${deps.adAccountId}/adcreatives`,
        buildCreativeParams(name, variant.input, pageId),
      ),
    );
    const creativeId = (creativeRes as { id?: string }).id;
    if (!creativeId) return fail("Meta did not return a creative id.");

    const adRes = check(
      await deps.client.post(`/${deps.adAccountId}/ads`, {
        name,
        adset_id: adsetId,
        creative: JSON.stringify({ creative_id: creativeId }),
        status: "PAUSED",
      }),
    );
    const adId = (adRes as { id?: string }).id;
    if (!adId) return fail("Meta did not return an ad id.");

    // Best-effort audit + idempotency: the ad already exists, so a bookkeeping
    // failure must not report the push as failed (which would also invite a
    // duplicate retry). Recorded on success only, so a failed push can retry.
    try {
      const ins = await sb
        .from("action_audit")
        .insert({
          shop_id: shopId,
          action_kind: "push_creative",
          params: {
            run_id: run.id,
            variant_index: variantIndex,
            source_ad_id: run.metaAdId,
            mode: variant.mode,
          },
          outcome: "succeeded",
          post_state: { ad_id: adId, creative_id: creativeId },
          actor_user_id: "merchant",
          completed_at: new Date().toISOString(),
        })
        .select("id")
        .single();
      const auditId = (ins.data as { id?: string } | null)?.id;
      if (auditId) {
        await sb
          .from("action_idempotency")
          .insert({ shop_id: shopId, idempotency_key: key, audit_id: auditId });
      }
    } catch {
      // Audit is secondary to the created ad; don't fail the push on it.
    }

    return { ok: true, adId, alreadyPushed: false, error: null };
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Push to Meta failed.");
  }
}
