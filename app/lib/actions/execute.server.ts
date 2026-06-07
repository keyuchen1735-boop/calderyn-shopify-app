// Execute a campaign action: idempotency -> ownership/resolve -> adapter call ->
// one append-only action_audit row. Ownership: the campaign must belong to the
// acting shop (cross-tenant guard) before any platform API call. Pre-state is
// read from ad_campaign_dim (synced by ingestion), so undo has a true baseline.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Platform } from "../ads/adapter";
import { actionAdapterForShop } from "../ads/action-registry.server";

export type ExecutableKind = "pause_campaign" | "reduce_campaign_budget";

export interface ExecuteInput {
  alertId: string | null;
  kind: ExecutableKind;
  campaignId: string; // ad_campaign_dim uuid
  idempotencyKey: string;
  dailyBudgetCents?: number;
  actor?: string;
}

export interface ExecutedAudit {
  id: string;
  outcome: "succeeded" | "failed";
}

export async function executeAction(
  shopId: string,
  input: ExecuteInput,
  sb: SupabaseClient,
): Promise<ExecutedAudit> {
  // 1. Idempotency.
  const { data: prior, error: pErr } = await sb
    .from("action_idempotency")
    .select("audit_id")
    .eq("shop_id", shopId)
    .eq("idempotency_key", input.idempotencyKey)
    .maybeSingle();
  if (pErr) throw pErr;
  if (prior?.audit_id) return { id: String(prior.audit_id), outcome: "succeeded" };

  // 2. Ownership + resolve campaign.
  const { data: camp, error: cErr } = await sb
    .from("ad_campaign_dim")
    .select("id, shop_id, external_id, platform, status, daily_budget_cents")
    .eq("id", input.campaignId)
    .eq("shop_id", shopId)
    .maybeSingle();
  if (cErr) throw cErr;
  if (!camp) throw new Error(`campaign ${input.campaignId} not found for shop (ownership check failed)`);

  const externalId = String(camp.external_id);
  const platform = String(camp.platform) as Platform;
  const preState = { status: camp.status, daily_budget_cents: camp.daily_budget_cents };
  const postState =
    input.kind === "reduce_campaign_budget"
      ? { status: camp.status, daily_budget_cents: input.dailyBudgetCents ?? null }
      : { status: "paused", daily_budget_cents: camp.daily_budget_cents };

  // 3. Resolve adapter + 4. call platform.
  let outcome: "succeeded" | "failed" = "succeeded";
  let lastError: string | null = null;
  const adapter = await actionAdapterForShop(shopId, platform);
  if (!adapter) {
    outcome = "failed";
    lastError = `${platform} not connected`;
  } else {
    try {
      if (input.kind === "pause_campaign") {
        await adapter.pause(externalId);
      } else {
        await adapter.setDailyBudget(externalId, input.dailyBudgetCents ?? 0);
      }
    } catch (err) {
      outcome = "failed";
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  // 5. One append-only audit row + idempotency.
  const { data: ins, error: iErr } = await sb
    .from("action_audit")
    .insert({
      shop_id: shopId,
      alert_id: input.alertId,
      action_kind: input.kind,
      params: { campaign_id: input.campaignId, external_id: externalId, platform, daily_budget_cents: input.dailyBudgetCents ?? null },
      outcome,
      pre_state: preState,
      post_state: outcome === "succeeded" ? postState : null,
      last_error: lastError,
      actor_user_id: input.actor ?? "merchant",
      completed_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (iErr) throw iErr;
  const auditId = String(ins.id);

  await sb.from("action_idempotency").insert({ shop_id: shopId, idempotency_key: input.idempotencyKey, audit_id: auditId });

  return { id: auditId, outcome };
}
