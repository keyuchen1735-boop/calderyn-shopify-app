// Reverse a prior action from its recorded pre_state, through the same action
// adapter. Append-only: writes a new action_audit row with undo_of set and
// pre/post swapped. Shop-scoped load is the ownership guard.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Platform } from "../ads/adapter";
import { actionAdapterForShop } from "../ads/action-registry.server";
import { type AdminGraphqlClient } from "../shopify/inventory.server";
import { inventoryAdjustQuantitiesForShop } from "../demo/showcase.server";
import { restoreProduct } from "../shopify/product.server";
import { setVariantPrice } from "../shopify/price.server";
import { setDoNotReorder } from "./discontinue.server";

// Undo windows: autonomous actions (actor_user_id='autopilot') get a 48-hour
// window because the merchant never clicked a button — they need more time to
// notice and reverse. Merchant-initiated actions keep the original 24-hour
// window (pre_state staleness risk is the same, but the merchant just acted).
// v_audit_view.undo_eligible mirrors the per-actor window via undo_expires_at
// (see the 20260621_autonomous_undo migration). Keep the two windows in sync.
export const UNDO_WINDOW_MS = 24 * 60 * 60 * 1000;
export const AUTONOMOUS_UNDO_WINDOW_MS = 48 * 60 * 60 * 1000;

/** Pick the undo window for an action based on who initiated it. */
export function undoWindowMs(actorUserId: string | null | undefined): number {
  return actorUserId === "autopilot" ? AUTONOMOUS_UNDO_WINDOW_MS : UNDO_WINDOW_MS;
}

// Current available units of a Shopify inventory item at one location, read
// FRESH from the latest inventory_level_fact snapshot. The audit params carry
// the location's external (Shopify) id and the inventory item id but not always
// the internal sku_id (alert-driven rows omit it), so resolve both ids here.
// Fail-closed: if the sku/location/snapshot can't be resolved, report 0 — the
// same stance executeInventoryRelocation takes (missing data ⇒ QTY_EXCEEDS).
async function availableAtLocation(
  sb: SupabaseClient,
  shopId: string,
  inventoryItemId: string,
  externalLocationId: string,
): Promise<number> {
  const { data: sku, error: sErr } = await sb
    .from("sku_dim")
    .select("id")
    .eq("shop_id", shopId)
    .eq("inventory_item_id", inventoryItemId)
    .maybeSingle();
  if (sErr) throw sErr;
  const { data: loc, error: lErr } = await sb
    .from("location_dim")
    .select("id")
    .eq("shop_id", shopId)
    .eq("external_id", externalLocationId)
    .maybeSingle();
  if (lErr) throw lErr;
  if (!sku?.id || !loc?.id) return 0;
  const { data: inv, error: iErr } = await sb
    .from("inventory_level_fact")
    .select("available, observed_at")
    .eq("shop_id", shopId)
    .eq("sku_id", sku.id)
    .eq("location_id", loc.id)
    .order("observed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (iErr) throw iErr;
  const n = Number(inv?.available ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export async function undoAction(
  shopId: string,
  auditId: string,
  sb: SupabaseClient,
  deps: { admin?: AdminGraphqlClient } = {},
): Promise<{ id: string }> {
  const { data: orig, error } = await sb
    .from("action_audit")
    .select("id, shop_id, alert_id, action_kind, params, pre_state, post_state, dollar_impact_at_exec, undo_of, outcome, created_at, actor_user_id")
    .eq("shop_id", shopId)
    .eq("id", auditId)
    .maybeSingle();
  if (error) throw error;
  if (!orig) throw new Error(`audit ${auditId} not found for shop`);

  // An undo row replays state (or, for inventory, a delta) — undoing it again
  // or undoing twice must be refused server-side, not just hidden by the UI's
  // undo_eligible flag (rule 12: the API is the real boundary). Read-then-act
  // guard, not a true unique constraint — a race between two concurrent undos
  // remains theoretically possible, as is the window where the reversal applies
  // but the undo-row insert below fails (see the insert error path); the DB
  // index is deliberately out of scope for this branch.
  if (orig.undo_of) {
    throw new Error(`audit ${auditId} is itself an undo; cannot undo an undo`);
  }
  // Only a succeeded action moved anything on the platform. A failed
  // reallocate_inventory audit still carries a full replayable plan (rule-12
  // failed rows), so without this guard its "undo" would fire a real reverse
  // transfer for stock that never moved. v_audit_view.undo_eligible only gates
  // the UI; the API is the real boundary.
  if (orig.outcome !== "succeeded") {
    throw new Error(`audit ${auditId} recorded outcome '${String(orig.outcome)}'; only succeeded actions can be undone`);
  }
  const { data: existingUndo, error: uErr } = await sb
    .from("action_audit")
    .select("id")
    .eq("shop_id", shopId)
    .eq("undo_of", orig.id)
    .limit(1)
    .maybeSingle();
  if (uErr) throw uErr;
  if (existingUndo) {
    throw new Error(`audit ${auditId} was already undone (${existingUndo.id})`);
  }

  // Actor-dependent undo window: 48h for autopilot actions, 24h for merchant.
  // action_audit.created_at is NOT NULL DEFAULT now(), so a real row always
  // carries it; when present we enforce the window here so the API matches
  // the undo_eligible the UI shows (via undo_expires_at in v_audit_view).
  // (A row with no/unparseable created_at can only be malformed test data,
  // never production — left unguarded rather than fail-closed.)
  const createdAtMs = orig.created_at ? Date.parse(String(orig.created_at)) : NaN;
  const windowMs = undoWindowMs(String(orig.actor_user_id ?? ""));
  if (Number.isFinite(createdAtMs) && Date.now() - createdAtMs > windowMs) {
    const hours = windowMs / (60 * 60 * 1000);
    throw new Error(`audit ${auditId} is outside the ${hours}-hour undo window`);
  }

  const params = (orig.params ?? {}) as { external_id?: string; platform?: string };
  const pre = (orig.pre_state ?? {}) as { status?: string; daily_budget_cents?: number | null };
  const externalId = String(params.external_id ?? "");
  const platform = String(params.platform ?? "") as Platform;

  // Resolved lazily so only campaign-kind undos demand an ads integration —
  // an inventory undo goes through the Shopify admin client instead.
  const requireAdapter = async () => {
    const adapter = await actionAdapterForShop(shopId, platform);
    if (!adapter) throw new Error(`${platform} not connected; cannot undo`);
    return adapter;
  };

  // Optimistic mirror restore for single-campaign undos: put ad_campaign_dim
  // back to pre_state so the campaigns view reflects the reversal immediately
  // (it reads the mirror via v_campaigns_flat; ingestion alone would otherwise
  // refresh it). No extra platform call; the next sync reconciles. Best-effort —
  // the platform reversal already happened, so a mirror-write failure must not
  // fail the undo. (reallocate_budget is two-sided; left to the next sync.)
  const mirrorBackToPreState = async () => {
    const { error: mirrorErr } = await sb
      .from("ad_campaign_dim")
      .update({ status: pre.status, daily_budget_cents: pre.daily_budget_cents })
      .eq("shop_id", shopId)
      .eq("platform", platform)
      .eq("external_id", externalId);
    if (mirrorErr) {
      console.error(`[undo] mirror restore failed for campaign ${externalId} (corrects on next sync)`, mirrorErr);
    }
  };

  // Set after the inventory branch fires its reverse transfer: an inventory
  // reversal is a relative delta, so retrying it double-applies — unlike the
  // campaign kinds, whose reversals are absolute-state and safe to retry.
  let appliedInventoryOperationId: string | null = null;

  // Single-campaign undos act on the campaign's external id. A blank id (e.g. a
  // legacy row that never recorded params.external_id) would hit the platform
  // with an empty campaign id — fail loudly instead of pausing/resuming nothing.
  if (
    orig.action_kind === "pause_campaign" ||
    orig.action_kind === "resume_campaign" ||
    orig.action_kind === "reduce_campaign_budget"
  ) {
    if (!externalId) throw new Error(`cannot undo ${String(orig.action_kind)}: missing campaign external id`);
  }

  if (orig.action_kind === "pause_campaign" || orig.action_kind === "resume_campaign") {
    // Both are status flips, so both undo the same way: put the campaign back
    // in whatever state pre_state recorded. Case-insensitive: orchestrator rows
    // snapshot lowercase ("active") from ad_campaign_dim, but legacy rows from
    // the old actions.execute path recorded Meta's uppercase ("ACTIVE").
    const adapter = await requireAdapter();
    if (String(pre.status).toLowerCase() === "active") await adapter.resume(externalId);
    else await adapter.pause(externalId);
    await mirrorBackToPreState();
  } else if (orig.action_kind === "reduce_campaign_budget") {
    const adapter = await requireAdapter();
    if (pre.daily_budget_cents != null) await adapter.setDailyBudget(externalId, pre.daily_budget_cents);
    await mirrorBackToPreState();
  } else if (orig.action_kind === "reallocate_budget") {
    const adapter = await requireAdapter();
    // Two-sided undo. `adapter` (resolved above from params.platform) IS the
    // dest adapter — replay params are written dest-side. Restore the dest
    // budget FIRST (reduce before increase: a mid-undo failure leaves the
    // merchant under-spending, never over-spending), then the source.
    const rp = (orig.params ?? {}) as {
      source_external_id?: string;
      source_platform?: string;
      dest_external_id?: string;
    };
    const rpre = (orig.pre_state ?? {}) as {
      source?: { daily_budget_cents?: number | null };
      dest?: { daily_budget_cents?: number | null };
    };
    if (rpre.dest?.daily_budget_cents != null) {
      await adapter.setDailyBudget(String(rp.dest_external_id ?? ""), rpre.dest.daily_budget_cents);
    }
    const srcPlatform = String(rp.source_platform ?? "") as Platform;
    const srcAdapter =
      srcPlatform === platform ? adapter : await actionAdapterForShop(shopId, srcPlatform);
    if (!srcAdapter) throw new Error(`${srcPlatform} not connected; cannot undo`);
    if (rpre.source?.daily_budget_cents != null) {
      await srcAdapter.setDailyBudget(String(rp.source_external_id ?? ""), rpre.source.daily_budget_cents);
    }
  } else if (orig.action_kind === "reallocate_inventory") {
    // Reverse transfer: same inventory item, locations swapped. Refuse loudly
    // without an admin client rather than record a success that never touched
    // Shopify (rule 12).
    if (!deps.admin) {
      throw new Error("Shopify admin client unavailable; cannot undo an inventory transfer");
    }
    const ip = (orig.params ?? {}) as {
      inventory_item_id?: string;
      from_location_id?: string;
      to_location_id?: string;
      delta?: number;
    };
    const delta = Number(ip.delta ?? 0);
    if (!ip.inventory_item_id || !ip.from_location_id || !ip.to_location_id || !delta) {
      throw new Error(`audit ${auditId} lacks a replayable transfer plan; cannot undo`);
    }
    // Fresh-availability guard. The reversal pulls `delta` OUT of the original
    // destination (ip.to_location_id). Even inside the 24h window a fast-moving
    // SKU in a previously starved region can sell through, so firing the fixed
    // reverse delta would overdraw it. Refuse loudly (rule 12) instead — the
    // forward path (executeInventoryRelocation) makes the same check before it
    // moves stock; the reverse must be just as careful.
    const destAvailable = await availableAtLocation(
      sb,
      shopId,
      ip.inventory_item_id,
      ip.to_location_id,
    );
    if (destAvailable < delta) {
      throw new Error(
        `cannot undo inventory transfer: ${ip.to_location_id} now holds ${destAvailable} unit${destAvailable === 1 ? "" : "s"}, fewer than the ${delta} the reverse would move back`,
      );
    }
    const reversal = await inventoryAdjustQuantitiesForShop(shopId, deps.admin, {
      inventoryItemId: ip.inventory_item_id,
      fromLocationId: ip.to_location_id,
      toLocationId: ip.from_location_id,
      delta,
    }, sb);
    appliedInventoryOperationId = reversal.operationId;
  } else if (orig.action_kind === "discontinue_sku") {
    // Reverse a discontinue: re-activate the product on Shopify, then clear the
    // internal flag. Refuse loudly without an admin client rather than record a
    // success that never touched Shopify (rule 12 — same stance as inventory).
    if (!deps.admin) {
      throw new Error("Shopify admin client unavailable; cannot undo a product discontinue");
    }
    const dp = (orig.params ?? {}) as { sku_id?: string; product_id?: string };
    if (!dp.product_id || !dp.sku_id) {
      throw new Error(`audit ${auditId} lacks the product/sku to restore; cannot undo`);
    }
    // Restore to ACTIVE (restoreProduct's default — the pre-status isn't captured
    // on the write path; a previously-DRAFT product re-activating is the safe,
    // visible default rather than staying archived).
    await restoreProduct(deps.admin, dp.product_id, "ACTIVE");
    await setDoNotReorder(sb, shopId, dp.sku_id, false);
  } else if (orig.action_kind === "adjust_price") {
    // Reverse a price change: write the recorded prior price back to the
    // variant. Absolute-state (like the campaign reversals), so a retry is
    // safe. Refuse loudly without an admin client rather than fake a success.
    if (!deps.admin) {
      throw new Error("Shopify admin client unavailable; cannot undo a price change");
    }
    const pp = (orig.params ?? {}) as {
      variant_id?: string;
      product_id?: string;
      prior_price_cents?: number;
    };
    if (!pp.variant_id || !pp.product_id || pp.prior_price_cents == null) {
      throw new Error(`audit ${auditId} lacks the variant/prior price to restore; cannot undo`);
    }
    await setVariantPrice(deps.admin, {
      productGid: pp.product_id,
      variantId: pp.variant_id,
      newPriceCents: Number(pp.prior_price_cents),
    });
  } else {
    // No platform reversal implemented for this kind — refuse loudly instead
    // of recording a "succeeded" undo that never touched the platform (rule 12).
    throw new Error(`undo not supported for action kind ${String(orig.action_kind)}`);
  }

  const { data: ins, error: iErr } = await sb
    .from("action_audit")
    .insert({
      shop_id: shopId,
      alert_id: orig.alert_id ?? null,
      action_kind: orig.action_kind,
      params: orig.params,
      outcome: "succeeded",
      pre_state: orig.post_state,
      post_state: orig.pre_state,
      // Signed pull-back: the undo row carries the negated impact of the action
      // it reverses, mirroring the alert-execute undo path (calderyn.server.ts).
      // recovered() excludes undo rows AND undone originals by id, so this value
      // never double-counts there; it keeps the audit ledger self-netting for
      // any naive SUM (e.g. the dashboard monorepo's query).
      dollar_impact_at_exec: orig.dollar_impact_at_exec ? -Number(orig.dollar_impact_at_exec) : 0,
      undo_of: orig.id,
      actor_user_id: "merchant",
      completed_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (iErr) {
    // The reversal applies BEFORE this insert, so a failure here leaves a real
    // platform change with no audit row. For inventory (delta-based) a retry
    // would double-apply the transfer — fail with an explicit do-not-retry
    // message. Campaign kinds fall through to the raw error: their reversals
    // restore absolute state, so retrying is safe.
    if (appliedInventoryOperationId) {
      console.error(
        `[undo] inventory reversal for audit ${auditId} (operation ${appliedInventoryOperationId}) applied to Shopify but undo row insert failed`,
        iErr,
      );
      throw new Error(
        `inventory reversal for audit ${auditId} was applied to Shopify but recording failed — do not retry; reconcile via the audit log`,
      );
    }
    throw iErr;
  }

  // Undo revives the underlying problem: acknowledge-on-execute (see
  // insertAuditWithIdempotency) closed the alert, so reversing the action
  // puts it back in the open queue. Lives HERE so every undo surface gets it
  // — the dashboard undo route and the reallocate delegation call this
  // directly, not the legacy wrapper in calderyn.server.ts (which has its own
  // copy for its own insert path). Best-effort: log, don't fail the recorded
  // undo — the platform reversal already happened.
  if (orig.alert_id) {
    const { error: reopenErr } = await sb
      .from("alerts")
      .update({ status: "open" })
      .eq("shop_id", shopId)
      .eq("id", orig.alert_id)
      .eq("status", "acknowledged");
    if (reopenErr) {
      console.error(`[undo] failed to re-open alert ${orig.alert_id} after undo of ${orig.id}`, reopenErr);
    }
  }

  // Record the undo as a negative calibration signal (graduation gate 5). Only
  // autopilot actions feed trust; a merchant undoing their OWN click is not a
  // veto of autonomy. Best-effort: log, never fail the recorded undo.
  if (String(orig.actor_user_id ?? "") === "autopilot" && orig.alert_id) {
    const { data: al } = await sb
      .from("alerts")
      .select("detector_id")
      .eq("shop_id", shopId)
      .eq("id", orig.alert_id)
      .maybeSingle();
    const detectorId = al?.detector_id ?? null;
    if (detectorId) {
      const { error: undoSigErr } = await sb.rpc("calibration_record_undo", {
        p_shop_id: shopId,
        p_detector_id: detectorId,
        p_action_kind: orig.action_kind,
      });
      if (undoSigErr) {
        console.error(`[undo] calibration_record_undo failed for ${detectorId}:${orig.action_kind}`, undoSigErr);
      }
    }
  }

  return { id: String(ins.id) };
}
