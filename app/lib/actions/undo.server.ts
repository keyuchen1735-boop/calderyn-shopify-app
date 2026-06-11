// Reverse a prior action from its recorded pre_state, through the same action
// adapter. Append-only: writes a new action_audit row with undo_of set and
// pre/post swapped. Shop-scoped load is the ownership guard.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Platform } from "../ads/adapter";
import { actionAdapterForShop } from "../ads/action-registry.server";
import { inventoryAdjustQuantities, type AdminGraphqlClient } from "../shopify/inventory.server";

export async function undoAction(
  shopId: string,
  auditId: string,
  sb: SupabaseClient,
  deps: { admin?: AdminGraphqlClient } = {},
): Promise<{ id: string }> {
  const { data: orig, error } = await sb
    .from("action_audit")
    .select("id, shop_id, alert_id, action_kind, params, pre_state, post_state, dollar_impact_at_exec, undo_of")
    .eq("shop_id", shopId)
    .eq("id", auditId)
    .maybeSingle();
  if (error) throw error;
  if (!orig) throw new Error(`audit ${auditId} not found for shop`);

  // An undo row replays state (or, for inventory, a delta) — undoing it again
  // or undoing twice must be refused server-side, not just hidden by the UI's
  // undo_eligible flag (rule 12: the API is the real boundary). Read-then-act
  // guard, not a true unique constraint — a race between two concurrent undos
  // remains theoretically possible; the DB index is deliberately out of scope
  // for this branch.
  if (orig.undo_of) {
    throw new Error(`audit ${auditId} is itself an undo; cannot undo an undo`);
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

  if (orig.action_kind === "pause_campaign" || orig.action_kind === "resume_campaign") {
    // Both are status flips, so both undo the same way: put the campaign back
    // in whatever state pre_state recorded.
    const adapter = await requireAdapter();
    if (pre.status === "active") await adapter.resume(externalId);
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
    await inventoryAdjustQuantities(deps.admin, {
      inventoryItemId: ip.inventory_item_id,
      fromLocationId: ip.to_location_id,
      toLocationId: ip.from_location_id,
      delta,
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
  if (iErr) throw iErr;

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

  return { id: String(ins.id) };
}
