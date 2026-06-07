// Reverse a prior action from its recorded pre_state, through the same action
// adapter. Append-only: writes a new action_audit row with undo_of set and
// pre/post swapped. Shop-scoped load is the ownership guard.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Platform } from "../ads/adapter";
import { actionAdapterForShop } from "../ads/action-registry.server";

export async function undoAction(shopId: string, auditId: string, sb: SupabaseClient): Promise<{ id: string }> {
  const { data: orig, error } = await sb
    .from("action_audit")
    .select("id, shop_id, action_kind, params, pre_state, post_state")
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

  if (orig.action_kind === "pause_campaign") {
    if (pre.status === "active") await adapter.resume(externalId);
    else await adapter.pause(externalId);
  } else if (orig.action_kind === "reduce_campaign_budget") {
    if (pre.daily_budget_cents != null) await adapter.setDailyBudget(externalId, pre.daily_budget_cents);
  }

  const { data: ins, error: iErr } = await sb
    .from("action_audit")
    .insert({
      shop_id: shopId,
      action_kind: orig.action_kind,
      params: orig.params,
      outcome: "succeeded",
      pre_state: orig.post_state,
      post_state: orig.pre_state,
      undo_of: orig.id,
      actor_user_id: "merchant",
      completed_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (iErr) throw iErr;
  return { id: String(ins.id) };
}
