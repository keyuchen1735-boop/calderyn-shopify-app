// Execute a campaign action: idempotency -> ownership/resolve -> adapter call ->
// one append-only action_audit row. Ownership: the campaign must belong to the
// acting shop (cross-tenant guard) before any platform API call. Pre-state is
// read from ad_campaign_dim (synced by ingestion), so undo has a true baseline.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Platform } from "../ads/adapter";
import type { ActionKind } from "../types";
import { isRetriableFailure, isValidRegion, type RegionCode } from "../ads/actions";
import { actionAdapterForShop } from "../ads/action-registry.server";
import { recoveredCentsForAction, recoveredCentsFromStates } from "../audit-impact";
import { acknowledgeAlert } from "../alerts.server";
import type { MetaWriteConn } from "../meta/ad-create.server";
import { createPausedAd, metaWriteClientForShopId } from "../meta/ad-create.server";
import { listCampaignAdSets, type MetaAdSet } from "../meta/creatives.server";
import type { MetaClient } from "../meta/campaigns.server";
import type { CreativeInput } from "~/lib/screener/types";

export type ExecutableKind =
  | "pause_campaign"
  | "resume_campaign"
  | "reduce_campaign_budget"
  | "increase_campaign_budget"
  | "exclude_geo"
  | "push_creative_draft"
  | "fulfill_order"
  | "cancel_order";

export interface ExecuteInput {
  alertId: string | null;
  kind: ExecutableKind;
  campaignId: string; // ad_campaign_dim uuid
  idempotencyKey: string;
  dailyBudgetCents?: number;
  /** Required for exclude_geo: the geographic region to drop from targeting. */
  region?: RegionCode;
  actor?: string;
  /** Plain-language reason persisted to action_audit.trigger_reason. Autopilot
   *  sets it; manual paths leave it undefined or null. */
  triggerReason?: string | null;
  /** Required for push_creative_draft: the winning variant to publish as a
   *  PAUSED draft ad. Ignored by every other kind. */
  creative?: CreativeInput;
}

/** Injectable Meta-write seams so the executor's push_creative_draft path is
 *  unit-testable without a live Graph client. Defaults wire the real helpers. */
export interface ExecuteDeps {
  resolveMetaWriteClient?: (shopId: string) => Promise<MetaWriteConn | null>;
  listCampaignAdSets?: (client: MetaClient, campaignId: string) => Promise<MetaAdSet[]>;
  createPausedAd?: (
    client: MetaClient,
    args: { adAccountId: string; adSetId: string; creative: CreativeInput },
  ) => Promise<{ adId: string }>;
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

/**
 * Which system a routed store mutation actually wrote to (extend:write-back).
 * `shopify_admin` = the Shopify Admin API (mirror/importing/dual_run authoritative);
 * `owned_sot` = Calderyn's owned catalog/inventory (org_mode=live). Persisted to
 * action_audit.write_target. Campaign actions (Meta/Google) leave it null.
 */
export type WriteTarget = "shopify_admin" | "owned_sot";

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
  /** The routed store-write target; null for campaign/platform actions. */
  write_target?: WriteTarget | null;
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
  deps: ExecuteDeps = {},
): Promise<ExecutedAudit> {
  // 0. Validate input: a missing/zero target budget must refuse loudly —
  // the old `?? 0` fallthrough would set the live campaign budget to $0.
  if (
    (input.kind === "reduce_campaign_budget" || input.kind === "increase_campaign_budget") &&
    !input.dailyBudgetCents
  ) {
    throw new Error(
      `${input.kind} for ${input.campaignId} has no positive dailyBudgetCents (alert evidence lacked the current budget)`,
    );
  }
  if (input.kind === "push_creative_draft" && !input.creative) {
    throw new Error(`push_creative_draft for ${input.campaignId} has no creative variant to publish`);
  }

  // exclude_geo must carry a VALID region bucket to drop. A missing or unknown
  // one fails visibly here (before any platform call) rather than reaching the
  // adapter's region->geo-id lookup with an undefined key (rule 12). Validating
  // in the shared executor covers every caller (both routes + autopilot).
  if (input.kind === "exclude_geo" && !isValidRegion(input.region)) {
    throw new Error(`exclude_geo for ${input.campaignId} has no valid region (got ${input.region ?? "none"})`);
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

  // Creative-draft is not a campaign mutation — it creates a NEW ad object, so
  // it has its own post-state shape and skips the campaign mirror. Routed here
  // (after idempotency + ownership) so it still inherits both for free.
  if (input.kind === "push_creative_draft") {
    return executePushCreativeDraft(shopId, input, sb, { camp, externalId, platform }, deps);
  }

  const postState =
    input.kind === "reduce_campaign_budget" || input.kind === "increase_campaign_budget"
      ? { status: camp.status, daily_budget_cents: input.dailyBudgetCents ?? null }
      : input.kind === "resume_campaign"
        ? { status: "active", daily_budget_cents: camp.daily_budget_cents }
        : input.kind === "exclude_geo"
          ? // Targeting change only: status/budget are unchanged. The excluded
            // region is recorded in audit params (below), not here, since postState
            // mirrors to ad_campaign_dim columns.
            { status: camp.status, daily_budget_cents: camp.daily_budget_cents }
          : { status: "paused", daily_budget_cents: camp.daily_budget_cents };

  // I5: Outcome-idempotent budget guard for reduce_campaign_budget.
  //
  // Two overlapping autopilot ticks can both compute the same newBudgetCents from
  // the v_autopilot_candidates snapshot (which is stale by the time the second
  // tick reads it). Without this guard, both ticks would call setDailyBudget to
  // the SAME target — a no-op on the platform but still a double-write that inflates
  // audit rows. Worse, if the first tick's mirror update (step 5 below) already
  // lowered ad_campaign_dim.daily_budget_cents below the target, the second tick
  // is cutting from a STALE snapshot and may over-cut.
  //
  // Guard: re-read the live budget from ad_campaign_dim (already available in
  // `camp` above — fresh from this request). If live budget is already <= target,
  // record a succeeded no-op audit row and return immediately without touching
  // the platform. This makes overlapping/replayed ticks idempotent on outcome.
  //
  // A budget re-read failure (null camp) was already handled above (ownership
  // check). Here `camp.daily_budget_cents` is the freshest value we have (just
  // read), so no additional DB call is needed.
  if (input.kind === "reduce_campaign_budget" && input.dailyBudgetCents !== undefined) {
    const liveBudget = camp.daily_budget_cents ?? 0;
    const target = input.dailyBudgetCents;
    if (liveBudget <= target) {
      // Already at or below target — no-op. Record as succeeded so the
      // idempotency key is consumed and a third tick won't try again.
      console.info(
        `[actions] reduce_campaign_budget no-op for ${input.campaignId}: live=${liveBudget}c <= target=${target}c (already at target)`,
      );
      return insertAuditWithIdempotency(
        shopId,
        input.idempotencyKey,
        {
          alert_id: input.alertId,
          action_kind: input.kind,
          params: {
            campaign_id: input.campaignId,
            external_id: externalId,
            platform,
            daily_budget_cents: target,
            noop_reason: "already_at_target",
          },
          outcome: "succeeded",
          pre_state: preState,
          post_state: { status: camp.status, daily_budget_cents: liveBudget },
          last_error: null,
          actor_user_id: input.actor ?? "merchant",
          trigger_reason: input.triggerReason ?? null,
        },
        sb,
      );
    }
  }

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
      } else if (input.kind === "exclude_geo") {
        // Region presence is validated at the top; assert for the type narrowing.
        await adapter.excludeGeo(externalId, input.region as RegionCode);
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
      params: { campaign_id: input.campaignId, external_id: externalId, platform, daily_budget_cents: input.dailyBudgetCents ?? null, region: input.region ?? null },
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

async function executePushCreativeDraft(
  shopId: string,
  input: ExecuteInput,
  sb: SupabaseClient,
  ctx: { camp: { status?: unknown; daily_budget_cents?: unknown }; externalId: string; platform: string },
  deps: ExecuteDeps,
): Promise<ExecutedAudit> {
  const { camp, externalId, platform } = ctx;
  const preState = { status: camp.status, daily_budget_cents: camp.daily_budget_cents };

  let outcome: "succeeded" | "failed" | "retrying" = "succeeded";
  let lastError: string | null = null;
  let postState: Record<string, unknown> | null = null;
  let adSetId: string | null = null;
  let createdAdId: string | null = null;

  if (platform.toLowerCase() !== "meta") {
    // Creative push is Meta-only; refuse on other platforms rather than forcing
    // Google/TikTok adapters to implement ad creation.
    outcome = "failed";
    lastError = `push_creative_draft is only supported on Meta (campaign platform: ${platform})`;
  } else {
    const resolveClient = deps.resolveMetaWriteClient ?? metaWriteClientForShopId;
    const listAdSets = deps.listCampaignAdSets ?? listCampaignAdSets;
    const create = deps.createPausedAd ?? createPausedAd;
    const conn = await resolveClient(shopId);
    if (!conn) {
      // No integration / token — permanent until reconnect, so fail fast rather
      // than burn the retry budget (mirrors the adapter-null path above).
      outcome = "failed";
      lastError = "Meta not connected";
    } else {
      try {
        const adsets = await listAdSets(conn.client, externalId);
        const target =
          adsets.find((a) => a.status === "ACTIVE") ??
          adsets.find((a) => a.status === "PAUSED") ??
          adsets[0];
        if (!target) throw new Error(`campaign ${externalId} has no ad set to receive the draft`);
        adSetId = target.id;
        const { adId } = await create(conn.client, {
          adAccountId: conn.adAccountId,
          adSetId,
          creative: input.creative as CreativeInput,
        });
        createdAdId = adId;
        postState = { created_ad_id: adId, status: "PAUSED", adset_id: adSetId };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        // Transient Meta errors park as `retrying`; known-permanent (ActionError
        // retriable:false — bad token/permission) fail terminally.
        outcome = isRetriableFailure(err) ? "retrying" : "failed";
      }
    }
  }

  // No ad_campaign_dim mirror: nothing about the campaign changed.
  return insertAuditWithIdempotency(
    shopId,
    input.idempotencyKey,
    {
      alert_id: input.alertId,
      action_kind: input.kind,
      params: {
        campaign_id: input.campaignId,
        external_id: externalId,
        platform,
        adset_id: adSetId,
        created_ad_id: createdAdId,
      },
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
