// Reverse a prior action from its recorded pre_state, through the same action
// adapter. Append-only: writes a new action_audit row with undo_of set and
// pre/post swapped. Shop-scoped load is the ownership guard.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Platform } from "../ads/adapter";
import { actionAdapterForShop } from "../ads/action-registry.server";

export async function undoAction(shopId: string, auditId: string, sb: SupabaseClient): Promise<{ id: string }> {
  const { data: orig, error } = await sb
    .from("action_audit")
    .select("id, shop_id, alert_id, action_kind, params, pre_state, post_state, dollar_impact_at_exec")
    .eq("shop_id", shopId)
    .eq("id", auditId)
    .maybeSingle();
  if (error) throw error;
  if (!orig) throw new Error(`audit ${auditId} not found for shop`);

  const params = (orig.params ?? {}) as { external_id?: string; platform?: string };
  const pre = (orig.pre_state ?? {}) as { status?: string; daily_budget_cents?: number | null };
  const externalId = String(params.external_id ?? "");
  const platform = String(params.platform ?? "") as Platform;

  const adapter = await actionAdapterForShop(shopId, platform);
  if (!adapter) throw new Error(`${platform} not connected; cannot undo`);

  if (orig.action_kind === "pause_campaign" || orig.action_kind === "resume_campaign") {
    // Both are status flips, so both undo the same way: put the campaign back
    // in whatever state pre_state recorded.
    if (pre.status === "active") await adapter.resume(externalId);
    else await adapter.pause(externalId);
  } else if (orig.action_kind === "reduce_campaign_budget") {
    if (pre.daily_budget_cents != null) await adapter.setDailyBudget(externalId, pre.daily_budget_cents);
  } else if (orig.action_kind === "reallocate_budget") {
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
