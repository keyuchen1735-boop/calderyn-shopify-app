import { getSupabase, resolveShopId } from "../supabase.server";
import { calderynClient } from "../calderyn.server";
import { metaClientForShop } from "../meta/client.server";
import { listCampaigns, fetchCampaignInsights, setCampaignBudget } from "../meta/campaigns.server";
import { planTick, type GatedMove } from "./tick.server";
import {
  DEFAULT_BUDGET_CONFIG,
  type BudgetConfig,
  type CampaignAlertDraft,
} from "./score.server";
import type { GateStatic } from "./guardrails.server";

const BUDGET_KINDS = ["reduce_campaign_budget", "increase_campaign_budget"];
const LOSER_DETECTORS = ["campaign_below_breakeven", "negative_unit_economics"];
const LOCK_STALE_MINUTES = 15;

export type ShopLoopResult = {
  shop: string;
  cutsApplied: number;
  feedsApplied: number;
  freedCents: number;
  blocked: number;
  campaignErrors: number;
  alertsUpserted: number;
  alertsResolved: number;
  skipped?: string;
};

function tickHour(now: Date): string {
  return now.toISOString().slice(0, 13); // e.g. "2026-06-02T15"
}

export async function runBudgetLoopForShop(shopDomain: string, now = new Date()): Promise<ShopLoopResult> {
  const sb = getSupabase();
  const shopId = await resolveShopId(shopDomain);
  const result: ShopLoopResult = {
    shop: shopDomain, cutsApplied: 0, feedsApplied: 0, freedCents: 0,
    blocked: 0, campaignErrors: 0, alertsUpserted: 0, alertsResolved: 0,
  };

  // Overlap guard: drop a stale lock, then claim. A live lock means another tick owns this shop.
  const staleBefore = new Date(now.getTime() - LOCK_STALE_MINUTES * 60000).toISOString();
  await sb.from("budget_loop_lock").delete().eq("shop_id", shopId).lt("locked_at", staleBefore);
  const claim = await sb.from("budget_loop_lock").insert({ shop_id: shopId, locked_at: now.toISOString() });
  if (claim.error) {
    result.skipped = "locked";
    return result;
  }

  try {
    const meta = await metaClientForShop(shopDomain);
    if (!meta) {
      result.skipped = "meta_not_connected";
      return result;
    }

    const { data: gc } = await sb.from("guardrail_config").select("*").eq("shop_id", shopId).maybeSingle();
    const cfg: BudgetConfig = {
      targetRoas: Number(gc?.target_roas ?? DEFAULT_BUDGET_CONFIG.targetRoas),
      loseBand: Number(gc?.lose_band ?? DEFAULT_BUDGET_CONFIG.loseBand),
      winBand: Number(gc?.win_band ?? DEFAULT_BUDGET_CONFIG.winBand),
      stepPct: Number(gc?.budget_step_pct ?? DEFAULT_BUDGET_CONFIG.stepPct),
      floorCents: Number(gc?.budget_floor_cents ?? DEFAULT_BUDGET_CONFIG.floorCents),
      ceilingPct: Number(gc?.budget_ceiling_pct ?? DEFAULT_BUDGET_CONFIG.ceilingPct),
      minSpend7dCents: Number(gc?.min_spend_7d_cents ?? DEFAULT_BUDGET_CONFIG.minSpend7dCents),
    };

    // Used-today + last-action-per-campaign from today's budget audits (UTC day).
    const dayStart = now.toISOString().slice(0, 10) + "T00:00:00Z";
    const { data: todays } = await sb
      .from("action_audit")
      .select("dollar_impact_at_exec, params, completed_at")
      .eq("shop_id", shopId)
      .in("action_kind", BUDGET_KINDS)
      .gte("completed_at", dayStart);
    let usedTodayCents = 0;
    const lastActionAtByCampaign: Record<string, string | null> = {};
    for (const r of todays ?? []) {
      usedTodayCents += Math.abs(Number(r.dollar_impact_at_exec ?? 0)) * 100;
      const cid = (r.params as { campaign_id?: string } | null)?.campaign_id;
      const t = r.completed_at ? String(r.completed_at) : null;
      if (cid && t) {
        const prev = lastActionAtByCampaign[cid];
        if (!prev || new Date(t) > new Date(prev)) lastActionAtByCampaign[cid] = t;
      }
    }

    const gate: GateStatic = {
      nowUtc: now,
      businessHoursStartUtc: Number(gc?.business_hours_start_utc ?? 0),
      businessHoursEndUtc: Number(gc?.business_hours_end_utc ?? 0),
      cooldownMinutes: Number(gc?.cooldown_minutes_per_campaign ?? 30),
      dollarCapCents: Math.round(Number(gc?.dollar_impact_cap_without_2fa ?? 0) * 100),
      dailyActionBudgetCents: Math.round(Number(gc?.daily_action_budget ?? 0) * 100),
      lastActionAtByCampaign,
    };

    const campaigns = await listCampaigns(meta.client, meta.adAccountId);
    const insights = await fetchCampaignInsights(meta.client, meta.adAccountId);
    const plan = planTick(campaigns, insights, cfg, gate, usedTodayCents);
    const client = calderynClient(shopDomain);

    const apply = async (m: GatedMove) => {
      if (m.decision === "block") {
        result.blocked += 1;
        return;
      }
      // Deterministic key: at most one cut and one feed per campaign per UTC hour.
      const key = `budget:${shopId}:${m.campaignId}:${tickHour(now)}:${m.role}`;

      // ATOMIC reservation BEFORE the Meta write. A PK conflict means this move
      // was already claimed this tick -> skip (no select-then-act race).
      const claimMove = await sb
        .from("budget_move_ledger")
        .insert({ shop_id: shopId, idempotency_key: key, applied_at: now.toISOString() });
      if (claimMove.error) return; // already claimed/applied this tick

      try {
        // Absolute write: re-applying the same toCents is a no-op, so an
        // at-least-once retry cannot move the budget twice.
        await setCampaignBudget(meta.client, m.campaignId, m.toCents);
        const kind = m.role === "cut" ? "reduce_campaign_budget" : "increase_campaign_budget";
        await client.actions.execute({
          alertId: null,
          kind,
          params: {
            role: m.role,
            campaign_id: m.campaignId,
            campaign_name: m.name,
            from_cents: m.fromCents,
            to_cents: m.toCents,
            delta_cents: m.deltaCents,
            roas7d: m.roas7d,
            target_roas: cfg.targetRoas,
            tick_hour: tickHour(now),
          },
          idempotencyKey: key,
          dollarImpactAtExec: Math.abs(m.deltaCents) / 100,
          preState: { campaign_id: m.campaignId, daily_budget_cents: m.fromCents },
          postState: { campaign_id: m.campaignId, daily_budget_cents: m.toCents },
        });
        if (m.role === "cut") {
          result.cutsApplied += 1;
          result.freedCents += Math.abs(m.deltaCents);
        } else {
          result.feedsApplied += 1;
        }
      } catch (err) {
        // Release the claim so a later tick can re-attempt; the absolute Meta
        // write makes a re-attempt safe. One bad campaign must not abort the
        // shop -> log and continue.
        await sb.from("budget_move_ledger").delete().eq("shop_id", shopId).eq("idempotency_key", key);
        result.campaignErrors += 1;
        console.error(`[cron.budget-loop] move failed shop=${shopDomain} campaign=${m.campaignId} role=${m.role}`, err);
      }
    };

    for (const m of plan.cuts) await apply(m); // phase A
    for (const m of plan.feeds) await apply(m); // phase B

    const alertOutcome = await upsertLoserAlerts(shopId, plan.loserAlerts, plan.breachingCampaignIds, now);
    result.alertsUpserted = alertOutcome.upserted;
    result.alertsResolved = alertOutcome.resolved;
    return result;
  } finally {
    await sb.from("budget_loop_lock").delete().eq("shop_id", shopId);
  }
}

async function upsertLoserAlerts(
  shopId: string,
  drafts: CampaignAlertDraft[],
  breachingIds: string[],
  now: Date,
): Promise<{ upserted: number; resolved: number }> {
  const sb = getSupabase();
  const dayBucket = now.toISOString().slice(0, 10);
  let upserted = 0;

  for (const d of drafts) {
    const { data: existing } = await sb
      .from("alerts")
      .select("id")
      .eq("shop_id", shopId)
      .eq("detector_id", d.detectorId)
      .eq("day_bucket", dayBucket)
      .filter("entity_ref->>campaign_id", "eq", d.entity_ref.campaign_id)
      .maybeSingle();

    let alertId: string;
    if (existing) {
      alertId = (existing as { id: string }).id;
      await sb
        .from("alerts")
        .update({
          severity: d.severity,
          dollar_impact: d.dollar_impact,
          claude_rank: d.claude_rank,
          claude_narrative: d.claude_narrative,
          entity_ref: d.entity_ref,
          status: "open",
          last_seen_at: now.toISOString(),
          resolved_at: null,
        })
        .eq("id", alertId);
    } else {
      const { data: ins, error: insErr } = await sb
        .from("alerts")
        .upsert(
          {
            shop_id: shopId,
            detector_id: d.detectorId,
            entity_ref: d.entity_ref,
            status: "open",
            severity: d.severity,
            dollar_impact: d.dollar_impact,
            day_bucket: dayBucket,
            claude_narrative: d.claude_narrative,
            claude_rank: d.claude_rank,
            first_seen_at: now.toISOString(),
            last_seen_at: now.toISOString(),
          },
          { onConflict: "shop_id,detector_id,entity_ref,day_bucket" },
        )
        .select("id")
        .single();
      if (insErr) throw insErr;
      alertId = (ins as { id: string }).id;
    }
    await sb
      .from("alert_context")
      .upsert(
        { alert_id: alertId, shop_id: shopId, evidence: d.evidence, created_at: now.toISOString() },
        { onConflict: "alert_id" },
      );
    upserted += 1;
  }

  // Recovery: resolve open campaign alerts whose campaign no longer breaches.
  const breaching = new Set(breachingIds);
  const { data: openRows } = await sb
    .from("alerts")
    .select("id, entity_ref")
    .eq("shop_id", shopId)
    .in("detector_id", LOSER_DETECTORS)
    .eq("status", "open");
  let resolved = 0;
  for (const r of openRows ?? []) {
    const cid = (r.entity_ref as { campaign_id?: string })?.campaign_id;
    if (cid && !breaching.has(cid)) {
      await sb.from("alerts").update({ status: "resolved", resolved_at: now.toISOString() }).eq("id", r.id);
      resolved += 1;
    }
  }
  return { upserted, resolved };
}
