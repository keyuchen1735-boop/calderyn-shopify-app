import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { getSupabase } from "~/lib/supabase.server";
import { firstRunPreflight } from "~/lib/meta/first-run.server";
import { metaWriteClientForShopId, metaDraftPushEnabled } from "~/lib/meta/ad-create.server";
import { createFirstCampaign, RollbackFailedError } from "~/lib/meta/campaign-create.server";
import { decideRunTransition, canonicalJson } from "~/lib/meta/first-run-state";
import { normalizeMetaCta } from "~/lib/meta/cta-types";
import { resolveCampaignDimId } from "~/lib/ads/campaign-dim.server";
import { insertAuditWithIdempotency } from "~/lib/actions/execute.server";
import type { CreativeInput } from "~/lib/screener/types";

// GET: Meta preflight for the first-campaign wizard (connected/scope/page/funding).
export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => firstRunPreflight(session.shopId, getSupabase()));
}

const MIN_BUDGET_CENTS = 500;
const MAX_BUDGET_CENTS = 20000;
const MAX_HEADLINE_LEN = 40;
const MAX_PRIMARY_TEXT_LEN = 500;

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export type ParsedFirstRun =
  | {
      ok: true;
      runId: string;
      productId: string;
      budgetCents: number;
      creative: {
        headline: string;
        primaryText: string;
        cta: string;
        imageUrl: string | null;
        destinationUrl: string;
      };
    }
  | { ok: false; error: { code: string; message: string } };

/**
 * Validate the wizard's Meta-create POST body. Pure — no DB/Meta access — so
 * every rejection path is table-tested without a server. Budget is clamped to
 * the same 500-20000c range createFirstCampaign asserts again server-side
 * (defense in depth, not redundant: this is the honest 422 for the merchant;
 * that's the last-resort guard against a caller that skips this parser).
 */
export function parseFirstRunBody(body: Record<string, unknown>): ParsedFirstRun {
  const fail = (code: string, message: string): ParsedFirstRun => ({ ok: false, error: { code, message } });

  const runId = str(body.runId);
  if (!runId) return fail("missing_run_id", "runId is required");

  const productId = str(body.productId);
  if (!productId) return fail("missing_product_id", "productId is required");

  const rawBudget = Number(body.budgetCents);
  const budgetCents = Math.round(rawBudget);
  if (!Number.isFinite(rawBudget) || budgetCents < MIN_BUDGET_CENTS || budgetCents > MAX_BUDGET_CENTS) {
    return fail(
      "budget_out_of_range",
      `budgetCents must be between ${MIN_BUDGET_CENTS} and ${MAX_BUDGET_CENTS}`,
    );
  }

  const creativeRaw =
    typeof body.creative === "object" && body.creative !== null
      ? (body.creative as Record<string, unknown>)
      : {};

  const headline = str(creativeRaw.headline).slice(0, MAX_HEADLINE_LEN);
  if (!headline) return fail("missing_headline", "creative.headline is required");

  const destinationUrlRaw = str(creativeRaw.destinationUrl);
  let destinationUrl: string;
  try {
    const u = new URL(destinationUrlRaw);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("unsupported protocol");
    destinationUrl = u.toString();
  } catch {
    return fail("missing_destination_url", "creative.destinationUrl must be a valid http(s) URL");
  }

  const primaryText = str(creativeRaw.primaryText).slice(0, MAX_PRIMARY_TEXT_LEN);
  // call_to_action.type is a Meta ENUM — free text (including AI-generated
  // copy like "Shop the sale") is rejected at ad-create time. Normalize and
  // whitelist; anything unrecognized becomes SHOP_NOW.
  const cta = normalizeMetaCta(str(creativeRaw.cta));
  const imageUrlRaw = str(creativeRaw.imageUrl);

  return {
    ok: true,
    runId,
    productId,
    budgetCents,
    creative: {
      headline,
      primaryText,
      cta,
      imageUrl: imageUrlRaw.length > 0 ? imageUrlRaw : null,
      destinationUrl,
    },
  };
}

/** Append the fixed Meta first-run UTM triple, keyed by run id so every run's
 *  traffic is distinguishable in storefront analytics. destinationUrl is
 *  already validated as an absolute http(s) URL by the parser. */
function withFirstRunUtm(destinationUrl: string, runId: string): string {
  const u = new URL(destinationUrl);
  u.searchParams.set("utm_source", "meta");
  u.searchParams.set("utm_medium", "paid");
  u.searchParams.set("utm_campaign", runId);
  return u.toString();
}

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  let rawBody: Record<string, unknown>;
  try {
    rawBody = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError(422, "invalid_json");
  }
  const parsed = parseFirstRunBody(rawBody);
  if (!parsed.ok) return jsonError(422, parsed.error.code, parsed.error.message);

  const sb = getSupabase();
  const shopId = session.shopId;
  const inputRecord = {
    product_id: parsed.productId,
    budget_cents: parsed.budgetCents,
    creative: parsed.creative,
  };

  return dashboardJson(async () => {
    // Defense in depth: the wizard's UI gate is advisory; a direct POST could
    // otherwise reach here without ads_management on the stored Meta token.
    if (!(await metaDraftPushEnabled(sb, shopId))) {
      throw jsonError(403, "meta_scope_insufficient");
    }

    // --- idempotency: one campaign_wizard_runs row per client-minted runId ---
    // decideRunTransition (pure, exhaustively unit-tested) is the ONLY judge of
    // whether this request may call Meta — the money-safety invariant is that a
    // runId whose row records a Meta campaign id never creates again.
    const { data: existing, error: selErr } = await sb
      .from("campaign_wizard_runs")
      .select("status, meta_campaign_id, updated_at, input")
      .eq("shop_id", shopId)
      .eq("id", parsed.runId)
      .maybeSingle();
    if (selErr) throw selErr;

    const transition = decideRunTransition(
      existing
        ? {
            status: String(existing.status),
            meta_campaign_id: (existing.meta_campaign_id as string | null) ?? null,
            updated_at: String(existing.updated_at),
          }
        : null,
      new Date().toISOString(),
    );

    if (transition === "fresh" || !existing) {
      // (`!existing` is for TS narrowing only — decideRunTransition returns
      // "fresh" exactly when the row is null.)
      const { error: insErr } = await sb
        .from("campaign_wizard_runs")
        .insert({ id: parsed.runId, shop_id: shopId, status: "creating", input: inputRecord });
      if (insErr) {
        // A concurrent request for the SAME runId lost the race to insert first.
        if ((insErr as { code?: string }).code === "23505") throw jsonError(409, "run_in_progress");
        throw insErr;
      }
    } else if (transition === "replay") {
      // Replay of an already-finished run: return the SAME campaign, never a
      // second Meta create. meta_campaign_id is always set once status flips
      // to 'created' (same update, below), so a missing dim row here means the
      // mirror write itself failed after a real success — surfaced as a
      // genuine 500 rather than silently 200-ing with a bogus id.
      const campaignDimId = existing.meta_campaign_id
        ? await resolveCampaignDimId(sb, shopId, "meta", String(existing.meta_campaign_id))
        : null;
      if (!campaignDimId) {
        throw new Error(
          `campaign_wizard_runs ${parsed.runId} is 'created' but its ad_campaign_dim mirror is missing`,
        );
      }
      return { run_id: parsed.runId, campaign_dim_id: campaignDimId, status: "created" as const };
    } else if (transition === "reject_in_progress") {
      throw jsonError(409, "run_in_progress");
    } else if (transition === "needs_review") {
      // A dead attempt already recorded a Meta campaign id (or the row is
      // unclassifiable). Creating again could double-create — refuse, honestly.
      throw jsonError(
        409,
        "run_needs_review",
        "A previous attempt left a paused campaign on Meta — nothing is spending; contact support or delete it in Ads Manager, then start a new campaign.",
      );
    } else {
      // reopen: a dead attempt with NO Meta object recorded — retrying the
      // same run is the idempotent-retry contract. Two guards:
      // 1. The retry must be for the SAME campaign — a stale runId must not
      //    silently redirect a run to different input.
      if (canonicalJson(existing.input) !== canonicalJson(inputRecord)) {
        throw jsonError(
          409,
          "run_input_mismatch",
          "This run id was already used with different campaign details — start over to create a new campaign.",
        );
      }
      // 2. Compare-and-set on the status we just read: a concurrent retry
      //    racing us here flips the row first and we lose (empty update).
      const { data: reopened, error: updErr } = await sb
        .from("campaign_wizard_runs")
        .update({ status: "creating", error: null, updated_at: new Date().toISOString() })
        .eq("id", parsed.runId)
        .eq("shop_id", shopId)
        .eq("status", String(existing.status))
        .select("id");
      if (updErr) throw updErr;
      if (!reopened || reopened.length === 0) throw jsonError(409, "run_in_progress");
    }

    const conn = await metaWriteClientForShopId(shopId);
    if (!conn) {
      // Nothing was created — reopen-able on the next attempt once Meta is
      // actually connected (not stuck at 'creating' forever).
      await sb
        .from("campaign_wizard_runs")
        .update({ status: "failed", error: "meta not connected", updated_at: new Date().toISOString() })
        .eq("shop_id", shopId)
        .eq("id", parsed.runId);
      throw jsonError(403, "meta_not_connected");
    }

    const { data: shopRow } = await sb.from("shops").select("country").eq("id", shopId).maybeSingle();
    const countryCode = (shopRow?.country as string | null) ?? "US";

    const creative: CreativeInput = {
      headline: parsed.creative.headline,
      primaryText: parsed.creative.primaryText,
      cta: parsed.creative.cta,
      imageUrl: parsed.creative.imageUrl,
      destinationUrl: withFirstRunUtm(parsed.creative.destinationUrl, parsed.runId),
      audience: "",
    };

    // Crash-window bookkeeping: the campaign id is written onto the run row the
    // moment Meta returns it, BEFORE the ad set is attempted. If the process
    // dies mid-build, the stale 'creating' row still carries the id, and
    // decideRunTransition routes the retry to needs_review instead of creating
    // a second campaign. If this write itself fails, createFirstCampaign aborts
    // before the ad set and rollback-deletes the campaign — never an object our
    // bookkeeping didn't record.
    const bookkeepCampaignId = async (campaignId: string): Promise<void> => {
      const { error } = await sb
        .from("campaign_wizard_runs")
        .update({ meta_campaign_id: campaignId, updated_at: new Date().toISOString() })
        .eq("shop_id", shopId)
        .eq("id", parsed.runId);
      if (error) throw error;
    };

    let created: { campaignId: string; adSetId: string; adId: string };
    try {
      created = await createFirstCampaign(
        conn,
        {
          name: parsed.creative.headline,
          dailyBudgetCents: parsed.budgetCents,
          countryCode,
          creative,
        },
        undefined,
        bookkeepCampaignId,
      );
    } catch (err) {
      // Honest regardless of thrown type: resolvePageId (inside createPausedAd)
      // throws a plain Error for "no Facebook Page", not an ActionError — never
      // assume otherwise.
      const message = err instanceof Error ? err.message : String(err);
      const orphanCampaignId = err instanceof RollbackFailedError ? err.orphanCampaignId : null;
      await sb
        .from("campaign_wizard_runs")
        .update({
          // RollbackFailedError = the rollback delete itself failed, leaving a
          // paused orphan on Meta that needs manual cleanup — 'failed', not
          // 'rolled_back' (which would be a lie).
          status: orphanCampaignId ? "failed" : "rolled_back",
          error: message,
          meta_campaign_id: orphanCampaignId,
          updated_at: new Date().toISOString(),
        })
        .eq("shop_id", shopId)
        .eq("id", parsed.runId);
      throw jsonError(502, "meta_create_failed", message);
    }

    // Past this point the campaign/ad set/ad exist on Meta (paused) — any
    // failure below is OUR bookkeeping, not Meta's, so it must never be
    // relabelled 'rolled_back' (nothing was rolled back). Surfaced as a plain
    // thrown error -> dashboardJson's generic 500, with the created ids saved
    // on the run row for manual reconciliation; the next ad ingest sync also
    // upserts ad_campaign_dim by (shop, platform, external_id) independently.
    const { data: dimRow, error: dimErr } = await sb
      .from("ad_campaign_dim")
      .upsert(
        {
          shop_id: shopId,
          platform: "meta",
          external_id: created.campaignId,
          name: parsed.creative.headline,
          status: "paused",
          daily_budget_cents: parsed.budgetCents,
        },
        { onConflict: "shop_id,platform,external_id" },
      )
      .select("id")
      .single();
    if (dimErr) {
      await sb
        .from("campaign_wizard_runs")
        .update({
          status: "failed",
          error: `meta objects created but ad_campaign_dim mirror failed: ${dimErr.message}`,
          meta_campaign_id: created.campaignId,
          meta_adset_id: created.adSetId,
          meta_ad_id: created.adId,
          updated_at: new Date().toISOString(),
        })
        .eq("shop_id", shopId)
        .eq("id", parsed.runId);
      throw dimErr;
    }
    const campaignDimId = String(dimRow.id);

    const { error: doneErr } = await sb
      .from("campaign_wizard_runs")
      .update({
        status: "created",
        meta_campaign_id: created.campaignId,
        meta_adset_id: created.adSetId,
        meta_ad_id: created.adId,
        updated_at: new Date().toISOString(),
      })
      .eq("shop_id", shopId)
      .eq("id", parsed.runId);
    if (doneErr) throw doneErr;

    await insertAuditWithIdempotency(
      shopId,
      `first_run:${parsed.runId}`,
      {
        alert_id: null,
        action_kind: "create_campaign_wizard",
        params: { run_id: parsed.runId, product_id: parsed.productId, budget_cents: parsed.budgetCents },
        outcome: "succeeded",
        pre_state: {},
        post_state: {
          meta_campaign_id: created.campaignId,
          meta_adset_id: created.adSetId,
          meta_ad_id: created.adId,
          campaign_dim_id: campaignDimId,
        },
        last_error: null,
        actor_user_id: "merchant",
        trigger_reason: "first_campaign_wizard",
      },
      sb,
    );

    return { run_id: parsed.runId, campaign_dim_id: campaignDimId, status: "created" as const };
  });
}
