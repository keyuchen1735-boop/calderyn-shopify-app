// Auto-pilot: for an opted-in shop, scan open money-losing alerts and act within
// guardrails, attributing every action to "autopilot". Reads candidates from the
// v_autopilot_candidates view (alert + campaign + 7d spend + current budget).

import type { SupabaseClient } from "@supabase/supabase-js";
import { checkGuardrails } from "./guardrails.server";
import { executeAction, type ExecutableKind, type ExecutedAudit } from "./execute.server";
import { executeReallocation } from "./reallocate.server";
import { loadReallocationCandidates, pickReallocation } from "./reallocation-suggest.server";
import { resolveScopedCandidates, type Candidate } from "./autopilot-targeting.server";
import { DETECTOR_LABELS } from "../labels";

const PAUSE_DETECTORS = new Set(["campaign_below_breakeven", "negative_unit_economics"]);
const BUDGET_DETECTORS = new Set(["ad_tax_overload"]);
const SCALE_DETECTORS = new Set(["campaign_scaling_opportunity"]);
const DEFAULT_MAX_CUT_PCT = 50; // mirrors the config default; the guardrail check enforces the live value
const DEFAULT_MAX_INCREASE_PCT = 20;

/** Per-candidate decision outcome. "skipped" = a pre-flight refusal (no
 *  guardrail call); "blocked" = a guardrail verdict refused it; "failed" = the
 *  executor was called but did not land (outcome "failed"/"retrying", or threw). */
export type AutopilotOutcome = "acted" | "blocked" | "skipped" | "failed";

/** One structured decision per candidate considered, so a silent run is
 *  auditable (rule 12: fail visibly). */
export interface AutopilotDecision {
  alertId: string;
  campaignId: string;
  detectorId: string;
  intendedKind: ExecutableKind | null;
  outcome: AutopilotOutcome;
  reason: string;
}

export interface AutopilotSummary {
  skipped: boolean;
  /** Actions that actually LANDED on the platform (executor outcome "succeeded"). */
  acted: number;
  /** Candidates a guardrail or pre-flight check refused (no budget written). */
  blocked: number;
  /** Attempted but did not land: executor returned "failed"/"retrying", or threw. */
  failed: number;
  /** Total candidates evaluated this run (one decision recorded per candidate). */
  considered: number;
  /** Why each blocked candidate was refused, keyed by reason — covers the full
   *  `blocked` total (guardrail verdicts AND pre-flight skips), so
   *  `sum(blockedReasons) === blocked`. */
  blockedReasons: Record<string, number>;
  /** Structured decision for every candidate considered. */
  decisions: AutopilotDecision[];
}

function autopilotReason(verb: string, detectorId: string, dollarImpact: number): string {
  const label = DETECTOR_LABELS[detectorId as keyof typeof DETECTOR_LABELS] ?? detectorId;
  const stake = Math.round(Number(dollarImpact) || 0).toLocaleString("en-US");
  return `${verb}: "${label}" — $${stake} at stake, within guardrails`;
}

export async function runAutopilotForShop(shopId: string, sb: SupabaseClient): Promise<AutopilotSummary> {
  const { data: cfg, error: cErr } = await sb
    .from("guardrail_config")
    .select("autopilot_enabled, autopilot_max_budget_cut_pct, autopilot_max_budget_increase_pct, autopilot_max_daily_budget_cents")
    .eq("shop_id", shopId)
    .maybeSingle();
  if (cErr) throw cErr;
  if (!cfg || !cfg.autopilot_enabled)
    return { skipped: true, acted: 0, blocked: 0, failed: 0, considered: 0, blockedReasons: {}, decisions: [] };

  const maxCutPct = Number(cfg.autopilot_max_budget_cut_pct ?? DEFAULT_MAX_CUT_PCT);
  const maxIncreasePct = Number(cfg.autopilot_max_budget_increase_pct ?? DEFAULT_MAX_INCREASE_PCT);
  const maxDailyBudgetCents =
    cfg.autopilot_max_daily_budget_cents == null ? null : Number(cfg.autopilot_max_daily_budget_cents);

  const { data: rows, error: aErr } = await sb
    .from("v_autopilot_candidates")
    .select("alert_id, detector_id, dollar_impact, campaign_id, campaign_spend_cents, daily_budget_cents")
    .eq("shop_id", shopId)
    .order("dollar_impact", { ascending: false });
  if (aErr) throw aErr;
  const candidates = (rows ?? []) as Candidate[];

  // D6: shop-scoped ad_tax_overload alerts carry no campaign_id, so they never
  // appear in v_autopilot_candidates. Resolve a campaign target for them and
  // feed them through the same defensive loop. (SKU-scoped negative_unit_economics
  // targeting is deferred — see spec §8.)
  const { data: scopedRows } = await sb
    .from("alerts")
    .select("id, detector_id, dollar_impact, entity_ref")
    .eq("shop_id", shopId)
    .eq("status", "open")
    .in("detector_id", ["ad_tax_overload"]);

  // Hoisted pool: serves BOTH the scoped-candidate resolver and every
  // reallocation decision in the loop. Load it if either needs it.
  const gradedPool =
    candidates.some((c) => BUDGET_DETECTORS.has(c.detector_id)) || (scopedRows ?? []).length > 0
      ? await loadReallocationCandidates(shopId, sb)
      : [];

  const scoped = await resolveScopedCandidates(shopId, (scopedRows ?? []) as never, gradedPool, sb);
  const allCandidates = [...candidates, ...scoped];

  // Defensive actions (pause/reduce/reallocate) take priority over offensive
  // scale-ups so loss-prevention is never starved of the daily action cap by a
  // bigger-dollar scale opportunity. Each subgroup keeps its dollar_impact order.
  const ordered = [
    ...allCandidates.filter((c) => !SCALE_DETECTORS.has(c.detector_id)),
    ...allCandidates.filter((c) => SCALE_DETECTORS.has(c.detector_id)),
  ];

  let acted = 0;
  let blocked = 0;
  let failed = 0;
  const decisions: AutopilotDecision[] = [];
  // reason -> count for every candidate that landed in the `blocked` counter
  // (guardrail blocks AND pre-flight skips), so the histogram explains the
  // FULL blocked total and `sum(blockedReasons) === blocked` holds.
  const blockedReasons: Record<string, number> = {};
  // Record one structured decision per candidate so the run is auditable even
  // when nothing acts (rule 12). The acted/blocked/failed COUNTERS keep their
  // existing buckets (a pre-flight refusal counts as `blocked`); the decision's
  // `outcome` carries the finer label (a pre-flight refusal is `skipped`, as
  // distinct from a guardrail `blocked`).
  const decide = (
    c: Candidate,
    intendedKind: ExecutableKind | null,
    outcome: AutopilotOutcome,
    reason: string,
    bucket: "acted" | "blocked" | "failed" | "none" = outcome === "skipped" ? "blocked" : outcome,
  ) => {
    if (bucket === "acted") acted += 1;
    else if (bucket === "blocked") {
      blocked += 1;
      blockedReasons[reason] = (blockedReasons[reason] ?? 0) + 1;
    } else if (bucket === "failed") failed += 1;
    decisions.push({
      alertId: c.alert_id,
      campaignId: c.campaign_id,
      detectorId: c.detector_id,
      intendedKind,
      outcome,
      reason,
    });
  };
  // Bucket an executor's REAL outcome: only a landed "succeeded" is an action
  // taken. "failed"/"retrying" (platform error, or parked for the retry cron)
  // did NOT change a budget this run, so they must not inflate `acted`.
  const record = (c: Candidate, kind: ExecutableKind, outcome: ExecutedAudit["outcome"]) =>
    outcome === "succeeded"
      ? decide(c, kind, "acted", kind)
      : decide(c, kind, "failed", `executor outcome: ${outcome}`);
  for (const c of ordered) {
    // Isolate each candidate. The guardrail read and both executors THROW on
    // per-campaign faults — an ownership mismatch, a DB hiccup, or a
    // stale-budget reallocation (live source budget dropped below the view
    // snapshot, so amount >= source budget). An uncaught throw here would
    // abort loss-prevention for the shop's OTHER money-losing campaigns, so
    // count it failed and keep draining.
    try {
      let kind: ExecutableKind | null = null;
      if (PAUSE_DETECTORS.has(c.detector_id)) kind = "pause_campaign";
      else if (BUDGET_DETECTORS.has(c.detector_id)) kind = "reduce_campaign_budget";
      else if (SCALE_DETECTORS.has(c.detector_id)) kind = "increase_campaign_budget";
      if (!kind) {
        decide(c, null, "skipped", "detector not actionable by autopilot", "none");
        continue;
      }

      const currentBudgetCents = c.daily_budget_cents ?? null;

      if (kind === "increase_campaign_budget") {
        if (!currentBudgetCents) {
          const reason =
            currentBudgetCents == null
              ? "current daily budget missing from sync"
              : "current daily budget is $0";
          console.info(`[autopilot] skipped scale on ${c.campaign_id}: ${reason}`);
          decide(c, kind, "skipped", reason);
          continue;
        }
        let target = Math.round(currentBudgetCents * (1 + maxIncreasePct / 100));
        if (maxDailyBudgetCents != null) target = Math.min(target, maxDailyBudgetCents);
        if (target <= currentBudgetCents) {
          const reason = "already at/above the daily ceiling";
          console.info(`[autopilot] skipped scale on ${c.campaign_id}: ${reason}`);
          decide(c, kind, "skipped", reason);
          continue;
        }
        const verdict = await checkGuardrails(
          shopId,
          {
            kind: "increase_campaign_budget",
            campaignId: c.campaign_id,
            dollarImpactCents: Math.round(Number(c.dollar_impact) * 100),
            campaignSpendCents: c.campaign_spend_cents,
            currentBudgetCents,
            newBudgetCents: target,
          },
          sb,
        );
        if (!verdict.allowed) {
          decide(c, kind, "blocked", verdict.reason ?? "blocked by guardrails");
          continue;
        }
        const res = await executeAction(
          shopId,
          {
            alertId: c.alert_id,
            kind: "increase_campaign_budget",
            campaignId: c.campaign_id,
            idempotencyKey: `autopilot:${c.alert_id}:increase_campaign_budget`,
            dailyBudgetCents: target,
            actor: "autopilot",
            triggerReason: autopilotReason("Auto scale budget", c.detector_id, c.dollar_impact),
          },
          sb,
        );
        record(c, kind, res.outcome);
        continue;
      }

      // A budget cut needs a known current budget to cut from. executeAction
      // refuses a missing/zero target budget (it would otherwise zero the live
      // campaign) — so count it blocked and keep draining the remaining candidates.
      if (kind === "reduce_campaign_budget" && !currentBudgetCents) {
        // Distinguish "no budget synced" from "budget is $0 on the platform" —
        // both skip, but they have different operator fixes.
        const reason =
          currentBudgetCents == null
            ? "current daily budget missing from sync"
            : "current daily budget is $0 on the platform";
        console.info(`[autopilot] skipped budget cut on ${c.campaign_id}: ${reason}`);
        decide(c, kind, "skipped", reason);
        continue;
      }

      const newBudgetCents =
        kind === "reduce_campaign_budget" && currentBudgetCents != null
          ? Math.round(currentBudgetCents * (1 - maxCutPct / 100))
          : undefined;

      // Same refusal in executeAction: a cut that lands on $0 would zero the
      // live campaign budget (that's a pause, not a reduction) — blocked. Only
      // reachable with maxCutPct near 100, so flag the config loudly.
      if (kind === "reduce_campaign_budget" && !newBudgetCents) {
        const reason = "max_budget_cut_pct computes a $0 target budget";
        console.warn(`[autopilot] skipped budget cut on ${c.campaign_id}: ${reason} (max_budget_cut_pct=${maxCutPct})`);
        decide(c, kind, "skipped", reason);
        continue;
      }

      // Budget detectors: prefer REDIRECTING the cut to a winning campaign on
      // another platform over shrinking total spend. Falls back to the plain
      // reduction below when no destination exists. A guardrail-blocked
      // reallocation does NOT fall through to reduce — same alert, same day,
      // one decision (counted as blocked).
      if (kind === "reduce_campaign_budget" && currentBudgetCents != null && newBudgetCents != null) {
        const amountCents = currentBudgetCents - newBudgetCents;
        if (amountCents > 0) {
          const { dest } = pickReallocation(gradedPool, { sourceCampaignId: c.campaign_id });
          if (dest) {
            const verdict = await checkGuardrails(
              shopId,
              {
                kind: "reallocate_budget",
                campaignId: c.campaign_id,
                destCampaignId: dest.campaignId,
                dollarImpactCents: amountCents,
                campaignSpendCents: c.campaign_spend_cents,
                currentBudgetCents,
                newBudgetCents,
              },
              sb,
            );
            if (!verdict.allowed) {
              decide(c, kind, "blocked", verdict.reason ?? "blocked by guardrails");
              continue;
            }
            const res = await executeReallocation(
              shopId,
              {
                alertId: c.alert_id,
                sourceCampaignId: c.campaign_id,
                destCampaignId: dest.campaignId,
                amountCents,
                idempotencyKey: `autopilot:${c.alert_id}:reallocate_budget`,
                actor: "autopilot",
                triggerReason: autopilotReason("Auto reallocate budget", c.detector_id, c.dollar_impact),
              },
              sb,
            );
            // The executed action is a reallocation, not a plain reduction —
            // label the decision accordingly while keeping intendedKind = reduce.
            res.outcome === "succeeded"
              ? decide(c, kind, "acted", "reallocate_budget")
              : decide(c, kind, "failed", `executor outcome: ${res.outcome}`);
            continue;
          }
        }
      }

      const verdict = await checkGuardrails(
        shopId,
        {
          kind,
          campaignId: c.campaign_id,
          dollarImpactCents: Math.round(Number(c.dollar_impact) * 100),
          campaignSpendCents: c.campaign_spend_cents,
          currentBudgetCents: currentBudgetCents ?? undefined,
          newBudgetCents,
        },
        sb,
      );
      if (!verdict.allowed) {
        decide(c, kind, "blocked", verdict.reason ?? "blocked by guardrails");
        continue;
      }

      const res = await executeAction(
        shopId,
        {
          alertId: c.alert_id,
          kind,
          campaignId: c.campaign_id,
          idempotencyKey: `autopilot:${c.alert_id}:${kind}`,
          dailyBudgetCents: newBudgetCents,
          actor: "autopilot",
          triggerReason: autopilotReason(
            kind === "pause_campaign" ? "Auto-pause" : "Auto budget cut",
            c.detector_id,
            c.dollar_impact,
          ),
        },
        sb,
      );
      record(c, kind, res.outcome);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[autopilot] candidate ${c.campaign_id} (alert ${c.alert_id}) errored: ${msg}`);
      decide(c, null, "failed", `threw: ${msg}`);
    }
  }

  return { skipped: false, acted, blocked, failed, considered: decisions.length, blockedReasons, decisions };
}
