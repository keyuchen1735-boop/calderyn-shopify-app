// Execute a campaign action: idempotency -> ownership/resolve -> adapter call ->
// one append-only action_audit row. Ownership: the campaign must belong to the
// acting shop (cross-tenant guard) before any platform API call. Pre-state is
// read from ad_campaign_dim (synced by ingestion), so undo has a true baseline.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Platform } from "../ads/adapter";
import type { ActionKind } from "../types";
import { isRetriableFailure } from "../ads/actions";
import { actionAdapterForShop } from "../ads/action-registry.server";
import { recoveredCentsForAction, recoveredCentsFromStates } from "../audit-impact";
import { acknowledgeAlert } from "../alerts.server";

export type ExecutableKind = "pause_campaign" | "resume_campaign" | "reduce_campaign_budget";

export interface ExecuteInput {
  alertId: string | null;
  kind: ExecutableKind;
  campaignId: string; // ad_campaign_dim uuid
  idempotencyKey: string;
  dailyBudgetCents?: number;
  actor?: string;
  /** Plain-language reason persisted to action_audit.trigger_reason. Autopilot
   *  sets it; manual paths leave it undefined. */
  triggerReason?: string;
}

export interface ExecutedAudit {
  id: string;
  /**
   * `retrying` is a transient platform failure parked for the action-retry
   * cron to replay (see retry.server.ts); it is NOT a success and NOT yet a
   * terminal failure.
   */
  outcome: "succeeded" | "failed" | "retrying";
}

/**
 * Idempotency guard shared by every executor: a replayed key returns the prior
 * attempt's REAL outcome — it may still be `retrying` (parked for the cron) or
 * have terminally `failed`. Reporting a hardcoded success here would mask a
 * not-yet-succeeded action (rule 12). Null means the key is fresh.
 */
export async function priorExecutionForKey(
  shopId: string,
  idempotencyKey: string,
  sb: SupabaseClient,
): Promise<ExecutedAudit | null> {
  const { data: prior, error: pErr } = await sb
    .from("action_idempotency")
    .select("audit_id")
    .eq("shop_id", shopId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (pErr) throw pErr;
  if (!prior?.audit_id) return null;
  const { data: prevAudit } = await sb
    .from("action_audit")
    .select("outcome")
    .eq("id", prior.audit_id)
    .maybeSingle();
  const priorOutcome = (prevAudit?.outcome as ExecutedAudit["outcome"]) ?? "succeeded";
  return { id: String(prior.audit_id), outcome: priorOutcome };
}

/**
 * Dollars a succeeded action recovers against its alert — the value persisted
 * in action_audit.dollar_impact_at_exec (column unit: dollars, matching
 * alerts.dollar_impact). EVERY write path that marks an audit row `succeeded`
 * (executeAction here, the legacy actions.execute path in calderyn.server.ts,
 * and the retry drain's replay success) must record this, or that action
 * silently never counts toward the Recovered-impact total. A lookup failure
 * must never block the action — the platform call already happened — so it
 * falls back to 0.
 *
 * Scoped to the acting shop: a cross-tenant `alert_id` (shop A supplying shop
 * B's alert) resolves to no row and contributes 0 — never another tenant's
 * dollar_impact toward this shop's Recovered total.
 */
export async function recoveredDollarsForAlertAction(
  sb: SupabaseClient,
  alertId: string | null,
  actionKind: string,
  shopId: string,
): Promise<number> {
  if (!alertId) return 0;
  try {
    const { data: al } = await sb
      .from("alerts")
      .select("dollar_impact")
      .eq("id", alertId)
      .eq("shop_id", shopId)
      .maybeSingle();
    const atStakeCents = Math.round(Number(al?.dollar_impact ?? 0) * 100);
    return recoveredCentsForAction(actionKind as ActionKind, atStakeCents) / 100;
  } catch (err) {
    console.error(`[actions] recovered-impact lookup failed for alert ${alertId}`, err);
    return 0;
  }
}

export interface AuditInsert {
  alert_id: string | null;
  action_kind: string;
  params: Record<string, unknown>;
  outcome: ExecutedAudit["outcome"];
  pre_state: Record<string, unknown>;
  post_state: Record<string, unknown> | null;
  last_error: string | null;
  actor_user_id: string;
  trigger_reason?: string | null;
}

/** The tail of every executor: ONE append-only audit row + its idempotency marker. */
export async function insertAuditWithIdempotency(
  shopId: string,
  idempotencyKey: string,
  audit: AuditInsert,
  sb: SupabaseClient,
): Promise<ExecutedAudit> {
  // Recovered impact: a value-recovering action that succeeds against an alert
  // claws back that alert's at-stake dollars; a no-alert action (campaigns
  // page, dashboard API) recovers what its own pre/post states prove it
  // stopped. Without this the Recovered-impact total is always $0.
  const dollarImpactAtExec =
    audit.outcome === "succeeded"
      ? audit.alert_id
        ? await recoveredDollarsForAlertAction(sb, audit.alert_id, audit.action_kind, shopId)
        : recoveredCentsFromStates(
            audit.action_kind as ActionKind,
            audit.pre_state,
            audit.post_state,
          ) / 100
      : 0;

  const { data: ins, error: iErr } = await sb
    .from("action_audit")
    .insert({
      shop_id: shopId,
      ...audit,
      dollar_impact_at_exec: dollarImpactAtExec,
      // A parked `retrying` row has already consumed its first attempt.
      attempts: audit.outcome === "retrying" ? 1 : 0,
      completed_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (iErr) throw iErr;
  const auditId = String(ins.id);

  const { error: idemErr } = await sb
    .from("action_idempotency")
    .insert({ shop_id: shopId, idempotency_key: idempotencyKey, audit_id: auditId });
  if (idemErr) {
    // The platform call already happened and the audit row exists — failing
    // now would provoke the duplicate execution the key prevents. Surface
    // the lost dedup protection loudly instead (rule 12).
    console.error(`[actions] idempotency insert failed for audit ${auditId} (key ${idempotencyKey})`, idemErr);
  }

  // A succeeded action against an alert closes it (open → acknowledged) on
  // EVERY executor path — autopilot, dashboard API, reallocation — not just
  // the alert-detail route. Every undo surface re-opens it (undo.server.ts
  // for the gateway paths, calderyn.server.ts for the legacy wrapper), and
  // the detector still owns resolution. Best-effort: acknowledgeAlert logs
  // and returns false rather than failing the already-executed action.
  if (audit.outcome === "succeeded" && audit.alert_id) {
    await acknowledgeAlert(sb, shopId, audit.alert_id);
  }

  return { id: auditId, outcome: audit.outcome };
}

export async function executeAction(
  shopId: string,
  input: ExecuteInput,
  sb: SupabaseClient,
): Promise<ExecutedAudit> {
  // 0. Validate input: a missing/zero target budget must refuse loudly —
  // the old `?? 0` fallthrough would set the live campaign budget to $0.
  if (input.kind === "reduce_campaign_budget" && !input.dailyBudgetCents) {
    throw new Error(
      `reduce_campaign_budget for ${input.campaignId} has no positive dailyBudgetCents (alert evidence lacked the current budget)`,
    );
  }

  // 1. Idempotency.
  const prior = await priorExecutionForKey(shopId, input.idempotencyKey, sb);
  if (prior) return prior;

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
      : input.kind === "resume_campaign"
        ? { status: "active", daily_budget_cents: camp.daily_budget_cents }
        : { status: "paused", daily_budget_cents: camp.daily_budget_cents };

  // 3. Resolve adapter + 4. call platform.
  let outcome: "succeeded" | "failed" | "retrying" = "succeeded";
  let lastError: string | null = null;
  const adapter = await actionAdapterForShop(shopId, platform);
  if (!adapter) {
    // No integration row — permanent until the merchant reconnects, so fail
    // fast rather than burning the retry budget against a disconnected platform.
    outcome = "failed";
    lastError = `${platform} not connected`;
  } else {
    try {
      if (input.kind === "pause_campaign") {
        await adapter.pause(externalId);
      } else if (input.kind === "resume_campaign") {
        await adapter.resume(externalId);
      } else {
        await adapter.setDailyBudget(externalId, input.dailyBudgetCents ?? 0);
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      // Transient failures are parked as `retrying` (attempts=1) for the
      // action-retry cron to replay; only known-permanent errors fail terminally.
      outcome = isRetriableFailure(err) ? "retrying" : "failed";
    }
  }

  // 5. Optimistic mirror update. The campaigns UI reads status/budget from
  // ad_campaign_dim (via v_campaigns_flat), which ingestion alone refreshes —
  // so without this the view stays stale between an action and the next sync.
  // We already KNOW the new state (postState) and the platform confirmed it, so
  // reflect it now. No extra platform call; the next ingest still reconciles.
  // Best-effort: the action already succeeded, so a mirror-write failure must
  // not fail it (rule 12 — surfaced, not swallowed).
  if (outcome === "succeeded") {
    const { error: mirrorErr } = await sb
      .from("ad_campaign_dim")
      .update(postState)
      .eq("id", input.campaignId)
      .eq("shop_id", shopId);
    if (mirrorErr) {
      console.error(
        `[actions] mirror update failed for campaign ${input.campaignId} (status will correct on next sync)`,
        mirrorErr,
      );
    }
  }

  // 6. One append-only audit row + idempotency.
  return insertAuditWithIdempotency(
    shopId,
    input.idempotencyKey,
    {
      alert_id: input.alertId,
      action_kind: input.kind,
      params: { campaign_id: input.campaignId, external_id: externalId, platform, daily_budget_cents: input.dailyBudgetCents ?? null },
      outcome,
      pre_state: preState,
      post_state: outcome === "succeeded" ? postState : null,
      last_error: lastError,
      actor_user_id: input.actor ?? "merchant",
      trigger_reason: input.triggerReason ?? null,
    },
    sb,
  );
}
