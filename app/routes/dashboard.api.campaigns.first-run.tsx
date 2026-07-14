import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import {
  dashboardJson,
  jsonError,
  requireSameOrigin,
} from "~/lib/dashboard/http.server";
import { getSupabase } from "~/lib/supabase.server";
import { firstRunPreflight } from "~/lib/meta/first-run.server";
import {
  metaWriteClientForShopId,
  metaDraftPushEnabled,
} from "~/lib/meta/ad-create.server";
import {
  createFirstCampaign,
  RollbackFailedError,
} from "~/lib/meta/campaign-create.server";
import { decideRunTransition, canonicalJson } from "~/lib/meta/first-run-state";
import { normalizeMetaCta } from "~/lib/meta/cta-types";
import { resolveCampaignDimId } from "~/lib/ads/campaign-dim.server";
import { getShopCountry } from "~/lib/ship-cost/shop-country.server";
import { insertAuditWithIdempotency } from "~/lib/actions/execute.server";
import type { CreativeInput } from "~/lib/screener/types";
import { isUuid } from "~/lib/ids";
import { getShopStorefrontOrigin } from "~/lib/storefront/shop.server";

// GET: Meta preflight for the first-campaign wizard (connected/scope/page/funding).
export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () =>
    firstRunPreflight(session.shopId, getSupabase()),
  );
}

const MIN_BUDGET_CENTS = 500;
const MAX_BUDGET_CENTS = 20000;
const MAX_HEADLINE_LEN = 40;
const MAX_PRIMARY_TEXT_LEN = 500;

const RUN_IN_PROGRESS_MESSAGE =
  "Still working on the last attempt — give it a moment and try again.";

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export type ParsedFirstRun =
  | {
      ok: true;
      runId: string;
      productId: string;
      budgetCents: number;
      placement: "facebook" | "instagram" | null;
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
export function parseFirstRunBody(
  body: Record<string, unknown>,
): ParsedFirstRun {
  const fail = (code: string, message: string): ParsedFirstRun => ({
    ok: false,
    error: { code, message },
  });

  const runId = str(body.runId);
  if (!runId) return fail("missing_run_id", "runId is required");
  if (!isUuid(runId))
    return fail("invalid_run_id", "runId must be a valid UUID");

  const productId = str(body.productId);
  if (!productId) return fail("missing_product_id", "productId is required");
  if (!isUuid(productId))
    return fail("invalid_product_id", "productId must be a valid UUID");

  const placementRaw = str(body.placement);
  const placement =
    placementRaw === "facebook" || placementRaw === "instagram"
      ? placementRaw
      : null;
  if (placementRaw && !placement) {
    return fail("invalid_placement", "placement must be facebook or instagram");
  }

  const rawBudget = Number(body.budgetCents);
  const budgetCents = Math.round(rawBudget);
  if (
    !Number.isFinite(rawBudget) ||
    budgetCents < MIN_BUDGET_CENTS ||
    budgetCents > MAX_BUDGET_CENTS
  ) {
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
  if (!headline)
    return fail("missing_headline", "creative.headline is required");

  const destinationUrlRaw = str(creativeRaw.destinationUrl);
  let destinationUrl: string;
  try {
    const u = new URL(destinationUrlRaw);
    if (u.protocol !== "http:" && u.protocol !== "https:")
      throw new Error("unsupported protocol");
    destinationUrl = u.toString();
  } catch {
    return fail(
      "missing_destination_url",
      "creative.destinationUrl must be a valid http(s) URL",
    );
  }

  const primaryText = str(creativeRaw.primaryText).slice(
    0,
    MAX_PRIMARY_TEXT_LEN,
  );
  if (!primaryText)
    return fail("missing_primary_text", "creative.primaryText is required");
  // call_to_action.type is a Meta ENUM — free text (including AI-generated
  // copy like "Shop the sale") is rejected at ad-create time. Normalize and
  // whitelist; anything unrecognized becomes SHOP_NOW.
  const cta = normalizeMetaCta(str(creativeRaw.cta));
  const imageUrlRaw = str(creativeRaw.imageUrl);
  if (!imageUrlRaw)
    return fail("missing_image_url", "creative.imageUrl is required");
  let imageUrl: string;
  try {
    const parsedImageUrl = new URL(imageUrlRaw);
    if (
      parsedImageUrl.protocol !== "http:" &&
      parsedImageUrl.protocol !== "https:"
    ) {
      throw new Error("unsupported protocol");
    }
    imageUrl = parsedImageUrl.toString();
  } catch {
    return fail(
      "invalid_image_url",
      "creative.imageUrl must be a valid http(s) URL",
    );
  }

  return {
    ok: true,
    runId,
    productId,
    budgetCents,
    placement,
    creative: {
      headline,
      primaryText,
      cta,
      imageUrl,
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
  if (!parsed.ok)
    return jsonError(422, parsed.error.code, parsed.error.message);

  const sb = getSupabase();
  const shopId = session.shopId;
  return dashboardJson(async () => {
    // Two independent reads, side by side. The scope gate is still checked
    // FIRST below — the run-row read is a shop-scoped select with no side
    // effects, so overlapping it never lets an unauthorized request act.
    const [
      pushEnabled,
      runRowRes,
      productRowRes,
      imageAssetRes,
      storefrontOrigin,
    ] = await Promise.all([
      // Defense in depth: the wizard's UI gate is advisory; a direct POST could
      // otherwise reach here without ads_management on the stored Meta token.
      metaDraftPushEnabled(sb, shopId),
      // --- idempotency: one campaign_wizard_runs row per client-minted runId ---
      // decideRunTransition (pure, exhaustively unit-tested) is the ONLY judge
      // of whether this request may call Meta — the money-safety invariant is
      // that a runId whose row records a Meta campaign id never creates again.
      sb
        .from("campaign_wizard_runs")
        .select("status, meta_campaign_id, updated_at, input")
        .eq("shop_id", shopId)
        .eq("id", parsed.runId)
        .maybeSingle(),
      // The product id is client-controlled. Verify it belongs to this shop
      // before creating a run row or touching Meta.
      sb
        .from("product_dim")
        .select("id, handle")
        .eq("shop_id", shopId)
        .eq("id", parsed.productId)
        .maybeSingle(),
      // Generated, mirrored product, and merchant-uploaded creative images all
      // live in the shop-owned asset registry. Never let an arbitrary remote
      // URL reach the publisher API.
      sb
        .from("asset_dim")
        .select("id")
        .eq("shop_id", shopId)
        .eq("public_url", parsed.creative.imageUrl)
        .limit(1)
        .maybeSingle(),
      getShopStorefrontOrigin(shopId),
    ]);
    if (!pushEnabled) {
      throw jsonError(
        403,
        "meta_scope_insufficient",
        "Your Meta connection doesn't allow creating ads — reconnect Meta with ad-management access.",
      );
    }
    const { data: existing, error: selErr } = runRowRes;
    if (selErr) throw selErr;
    if (productRowRes.error) throw productRowRes.error;
    if (!productRowRes.data) {
      throw jsonError(
        404,
        "product_not_found",
        "That product is no longer available in your catalog.",
      );
    }
    if (imageAssetRes.error) throw imageAssetRes.error;
    if (!imageAssetRes.data) {
      throw jsonError(
        422,
        "creative_image_not_owned",
        "Choose a generated image or upload one from the review screen.",
      );
    }
    const productDestinationUrl = storefrontOrigin
      ? `${storefrontOrigin}/storefront/products/${String(productRowRes.data.handle)}`
      : new URL(
          `/storefront/products/${String(productRowRes.data.handle)}`,
          request.url,
        ).toString();
    const canonicalCreative = {
      ...parsed.creative,
      destinationUrl: productDestinationUrl,
    };
    const inputRecord = {
      product_id: parsed.productId,
      budget_cents: parsed.budgetCents,
      ...(parsed.placement ? { placement: parsed.placement } : {}),
      creative: canonicalCreative,
    };

    const transition = decideRunTransition(
      existing
        ? {
            status: String(existing.status),
            meta_campaign_id:
              (existing.meta_campaign_id as string | null) ?? null,
            updated_at: String(existing.updated_at),
          }
        : null,
      new Date().toISOString(),
    );

    if (transition === "fresh" || !existing) {
      // (`!existing` is for TS narrowing only — decideRunTransition returns
      // "fresh" exactly when the row is null.)
      const { error: insErr } = await sb.from("campaign_wizard_runs").insert({
        id: parsed.runId,
        shop_id: shopId,
        status: "creating",
        input: inputRecord,
      });
      if (insErr) {
        // A concurrent request for the SAME runId lost the race to insert first.
        if ((insErr as { code?: string }).code === "23505") {
          throw jsonError(409, "run_in_progress", RUN_IN_PROGRESS_MESSAGE);
        }
        throw insErr;
      }
    } else if (transition === "replay") {
      // Replay of an already-finished run: return the SAME campaign, never a
      // second Meta create. meta_campaign_id is always set once status flips
      // to 'created' (same update, below), so a missing dim row here means the
      // mirror write itself failed after a real success — surfaced as a
      // genuine 500 rather than silently 200-ing with a bogus id.
      const campaignDimId = existing.meta_campaign_id
        ? await resolveCampaignDimId(
            sb,
            shopId,
            "meta",
            String(existing.meta_campaign_id),
          )
        : null;
      if (!campaignDimId) {
        throw new Error(
          `campaign_wizard_runs ${parsed.runId} is 'created' but its ad_campaign_dim mirror is missing`,
        );
      }
      return {
        run_id: parsed.runId,
        campaign_dim_id: campaignDimId,
        status: "created" as const,
      };
    } else if (transition === "reject_in_progress") {
      throw jsonError(409, "run_in_progress", RUN_IN_PROGRESS_MESSAGE);
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
      // 2. Compare-and-set on the (status, updated_at) we just read: a
      //    concurrent retry racing us flips the row first and we lose (empty
      //    update). Status alone can't fence the stale-'creating' source —
      //    the winner sets status right back to 'creating', so a second retry
      //    would still match on status; the winner's updated_at bump is what
      //    makes this a real fencing token for BOTH reopen sources
      //    (failed/rolled_back AND stale-creating).
      const { data: reopened, error: updErr } = await sb
        .from("campaign_wizard_runs")
        .update({
          status: "creating",
          error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", parsed.runId)
        .eq("shop_id", shopId)
        .eq("status", String(existing.status))
        .eq("updated_at", String(existing.updated_at))
        .select("id");
      if (updErr) throw updErr;
      if (!reopened || reopened.length === 0) {
        throw jsonError(409, "run_in_progress", RUN_IN_PROGRESS_MESSAGE);
      }
    }

    // Independent resolutions, side by side. Country comes from getShopCountry
    // (shop-country.server.ts) — shops has NO country column yet, so it returns
    // null by design and campaigns target the US until that module's TODO
    // (source shop origin country) lands; it stays the single source of truth
    // when the column arrives. A raw `select country from shops` here would
    // simply error.
    const [conn, shopCountry] = await Promise.all([
      metaWriteClientForShopId(shopId),
      getShopCountry(sb, shopId),
    ]);
    if (!conn) {
      // Nothing was created — reopen-able on the next attempt once Meta is
      // actually connected (not stuck at 'creating' forever).
      await sb
        .from("campaign_wizard_runs")
        .update({
          status: "failed",
          error: "meta not connected",
          updated_at: new Date().toISOString(),
        })
        .eq("shop_id", shopId)
        .eq("id", parsed.runId);
      throw jsonError(
        403,
        "meta_not_connected",
        "Connect your Meta account first — the connection may have expired.",
      );
    }
    const countryCode = shopCountry ?? "US";

    const creative: CreativeInput = {
      headline: canonicalCreative.headline,
      primaryText: canonicalCreative.primaryText,
      cta: canonicalCreative.cta,
      imageUrl: canonicalCreative.imageUrl,
      destinationUrl: withFirstRunUtm(productDestinationUrl, parsed.runId),
      audience: "",
    };

    // Crash-window bookkeeping: the campaign id is written onto the run row the
    // moment Meta returns it, BEFORE the ad set is attempted. If the process
    // dies mid-build, the stale 'creating' row still carries the id, and
    // decideRunTransition routes the retry to needs_review instead of creating
    // a second campaign. If this write itself fails, createFirstCampaign aborts
    // before the ad set and rollback-deletes the campaign. A residual window
    // remains: the process dying in the milliseconds between Meta accepting the
    // campaign POST and this write committing leaves an unrecorded (paused,
    // non-spending) campaign — unavoidable without Meta-side idempotency keys.
    const bookkeepCampaignId = async (campaignId: string): Promise<void> => {
      const { error } = await sb
        .from("campaign_wizard_runs")
        .update({
          meta_campaign_id: campaignId,
          updated_at: new Date().toISOString(),
        })
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
          publisherPlatform: parsed.placement ?? undefined,
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
      const orphanCampaignId =
        err instanceof RollbackFailedError ? err.orphanCampaignId : null;
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

    // Straight to insertAuditWithIdempotency, bypassing executeAction: this kind
    // is not an ExecutableKind — creation is orchestrated by the run-state
    // machine above, which already provides the idempotency + ownership
    // guarantees executeAction normally supplies.
    await insertAuditWithIdempotency(
      shopId,
      `first_run:${parsed.runId}`,
      {
        alert_id: null,
        action_kind: "create_campaign_wizard",
        params: {
          run_id: parsed.runId,
          product_id: parsed.productId,
          budget_cents: parsed.budgetCents,
          // v_audit_view's target coalesce reads campaign_name/campaign_id —
          // without these the audit row renders with a blank target.
          campaign_id: campaignDimId,
          campaign_name: parsed.creative.headline,
        },
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

    return {
      run_id: parsed.runId,
      campaign_dim_id: campaignDimId,
      status: "created" as const,
    };
  });
}
