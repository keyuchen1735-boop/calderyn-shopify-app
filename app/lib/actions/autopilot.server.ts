// Auto-pilot: for an opted-in shop, scan open money-losing alerts and act within
// guardrails, attributing every action to "autopilot". Reads candidates from the
// v_autopilot_candidates view (alert + campaign + 7d spend + current budget).

import type { SupabaseClient } from "@supabase/supabase-js";
import { getActionPolicy } from "./action-policy.server";
import { checkGuardrails } from "./guardrails.server";
import { executeAction, type ExecutableKind, type ExecutedAudit } from "./execute.server";
import { executeReallocation } from "./reallocate.server";
import { loadReallocationCandidates, pickReallocation } from "./reallocation-suggest.server";
import { resolveScopedCandidates, type Candidate } from "./autopilot-targeting.server";
import { DETECTOR_LABELS } from "../labels";
import { isGraduated } from "../calibration/graduation.server";
import { preconditionFresh, stockoutPauseAllowed } from "../calibration/preconditions.server";
import { loadAndApplyRules } from "./rule-enforce.server";
import { notifyAutonomousAction } from "../calibration/notify-autonomous.server";
import { acquireAutopilotLock, releaseAutopilotLock } from "./autopilot-lock.server";

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

  // I6: Per-shop concurrency lock — prevents overlapping cron ticks from
  // double-acting on the same shop. Fail-safe: if the lock is NOT acquired
  // (concurrent tick holds it, OR the DB call errored), we skip this tick
  // rather than running unlocked and risking double-action.
  //
  // Mechanism: TTL-row (not pg_try_advisory_lock) because Supabase uses
  // PgBouncer in Transaction mode — advisory locks are session-scoped and
  // are immediately released when the connection returns to the pool, so
  // they provide zero protection over a pooled client.
  const lock = await acquireAutopilotLock(shopId, sb);
  if (!lock.acquired) {
    console.info(`[autopilot] skipping shop ${shopId}: ${lock.reason ?? "lock not acquired"}`);
    return {
      skipped: true,
      acted: 0,
      blocked: 0,
      failed: 0,
      considered: 0,
      blockedReasons: {},
      decisions: [],
    };
  }

  // I6: Wrap the entire tick in try/finally so the lock is ALWAYS released,
  // even if a DB error or throw escapes the per-candidate catch blocks below.
  try {

  // Load merchant contact email for autonomous-action notifications (best-effort;
  // a missing email row just means no notification fires — never a thrown error).
  // Email lives in shopify_sessions (online sessions carry the account-owner email);
  // join via shops.shop_domain → shopify_sessions.shop, preferring online sessions.
  let merchantEmail: string | null = null;
  try {
    const { data: shopRow } = await sb
      .from("shops")
      .select("shop_domain")
      .eq("id", shopId)
      .maybeSingle();
    const shopDomain = (shopRow as { shop_domain?: string | null } | null)?.shop_domain ?? null;
    if (shopDomain) {
      const { data: sessions } = await sb
        .from("shopify_sessions")
        .select("email, isOnline, accountOwner")
        .eq("shop", shopDomain)
        .not("email", "is", null);
      // Prefer: online + accountOwner first, then online, then offline accountOwner, then any.
      const rows = (sessions ?? []) as Array<{
        email: string | null;
        isOnline: boolean;
        accountOwner: boolean;
      }>;
      const best =
        rows.find((r) => r.isOnline && r.accountOwner) ??
        rows.find((r) => r.isOnline) ??
        rows.find((r) => r.accountOwner) ??
        rows[0] ??
        null;
      merchantEmail = best?.email ?? null;
    }
  } catch {
    // Non-fatal: if we can't read the session email, we just skip the notification.
  }

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
  // Collect notify promises so they are awaited (via Promise.allSettled) before
  // runAutopilotForShop returns. This prevents Vercel cron from abandoning them
  // mid-flight when the response is sent. allSettled means a delivery failure
  // never fails the run or affects the summary.
  const notifyPromises: Promise<void>[] = [];
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

      // Graduation gate (Slice 5 Task 2, I3/I7): a (detector, action) pair MUST
      // have earned calibration graduation before it may auto-execute. isGraduated
      // is fail-safe (returns false on any read error), so a DB hiccup can never
      // grant autonomy. With no pair graduated yet, autopilot skips everything —
      // that is the intended "gate everything, re-earn trust" default.
      if (!(await isGraduated(shopId, c.detector_id, kind, sb))) {
        decide(c, kind, "skipped", "pair not graduated");
        continue;
      }

      // Rule enforcement (Slice 5 Task 5): apply the merchant's learned
      // calibration_rule rows for this (detector, action) pair BEFORE any
      // execute path is reached. This single check dominates all execute paths
      // for the three graduatable kinds (pause/reduce/increase).
      // Fail-safe: a thrown load returns { veto: "rules unavailable" } —
      // we must never execute when we can't verify the merchant's restrictions.
      {
        const nowUtc = new Date();
        const ruleVerdict = await loadAndApplyRules(
          shopId,
          c.detector_id,
          kind,
          {
            dollarImpactCents: Math.round(Number(c.dollar_impact) * 100),
            campaignSpendCents: c.campaign_spend_cents,
            nowUtcHour: nowUtc.getUTCHours(),
            nowIso: nowUtc.toISOString(),
          },
          sb,
        );
        if (ruleVerdict.veto) {
          console.info(`[autopilot] rule veto for ${c.campaign_id} (${c.detector_id}/${kind}): ${ruleVerdict.veto}`);
          decide(c, kind, "skipped", `rule: ${ruleVerdict.veto}`);
          continue;
        }
        // pair_dollar_cap on reduce: cap the cut amount by storing into a
        // candidate-local that the reduce path reads below.
        if (ruleVerdict.cappedDollarCents !== undefined) {
          // Stash the cap so the reduce path clamps newBudgetCents.
          // We piggy-back on the existing Candidate shape via a local variable.
          // The capped amount is resolved after currentBudgetCents is known, below.
          (c as Candidate & { _cappedDollarCents?: number })._cappedDollarCents = ruleVerdict.cappedDollarCents;
        }
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
        const muInc = (await getActionPolicy(sb, shopId, c.detector_id, "increase_campaign_budget")) ?? 1;
        let target = Math.round(currentBudgetCents * (1 + (maxIncreasePct * muInc) / 100));
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
          { forceBypassOff: true, autonomous: true },
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
        if (res.outcome === "succeeded") {
          // Collect for await Promise.allSettled at end of run — prevents serverless abandonment.
          notifyPromises.push(
            notifyAutonomousAction(
              { shopId, actionDescription: `Scaled up campaign budget (campaign ${c.campaign_id})` },
              merchantEmail,
            ).catch((e) => console.error("[autopilot-notify] unexpected error (budget scale)", e)),
          );
        }
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

      const muCut =
        kind === "reduce_campaign_budget"
          ? (await getActionPolicy(sb, shopId, c.detector_id, "reduce_campaign_budget")) ?? 1
          : 1;
      let newBudgetCents =
        kind === "reduce_campaign_budget" && currentBudgetCents != null
          ? Math.round(currentBudgetCents * (1 - (maxCutPct * muCut) / 100))
          : undefined;

      // pair_dollar_cap clamp for reduce: ensure the cut (currentBudgetCents -
      // newBudgetCents) does not exceed the merchant's dollar cap. The cap was
      // stashed by the rule-enforcement block above. This adjusts the target
      // upward so the cut is smaller — never executes a bigger cut than allowed.
      if (
        kind === "reduce_campaign_budget" &&
        currentBudgetCents != null &&
        newBudgetCents !== undefined
      ) {
        const cappedCents = (c as Candidate & { _cappedDollarCents?: number })._cappedDollarCents;
        if (cappedCents !== undefined) {
          // Clamp: newBudgetCents >= currentBudgetCents - cappedCents
          newBudgetCents = Math.max(newBudgetCents, currentBudgetCents - cappedCents);
          console.info(
            `[autopilot] pair_dollar_cap clamped reduce for ${c.campaign_id}: newBudget=${newBudgetCents}c (cap=${cappedCents}c)`,
          );
        }
      }

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
      //
      // Magnitude: reallocation has its OWN learned dial. We recompute the moved
      // amount from `muRealloc` (the trainer's separate reallocate_budget policy)
      // rather than inheriting the reduce dial baked into newBudgetCents — so that
      // model family is actually consumed. If muRealloc zeroes the move, we fall
      // through to a plain reduce so loss-prevention still acts. Dormant-safe: with
      // no model both dials default to 1, so the moved amount equals prior behavior
      // (currentBudgetCents - newBudgetCents). muRealloc ∈ [0,1] keeps the implied
      // cut ≤ maxCutPct, so checkGuardrails (unchanged) still enforces the ceiling.
      //
      // Calibration gate: reallocate_budget is NOT in GRADUATABLE_V1 and can NEVER
      // auto-execute in v1. Even if reduce_campaign_budget is graduated, we must
      // independently verify reallocate_budget graduation before entering the
      // reallocation sub-branch. This prevents a graduated reduce from smuggling in
      // an autonomous reallocation. When not graduated (always in v1), fall through
      // to the plain reduce path so loss-prevention still acts.
      if (kind === "reduce_campaign_budget" && currentBudgetCents != null && newBudgetCents != null) {
        if (currentBudgetCents - newBudgetCents > 0) {
          const { dest } = pickReallocation(gradedPool, { sourceCampaignId: c.campaign_id });
          if (dest && (await isGraduated(shopId, c.detector_id, "reallocate_budget", sb))) {
            const muRealloc = (await getActionPolicy(sb, shopId, c.detector_id, "reallocate_budget")) ?? 1;
            const amountCents = Math.round((currentBudgetCents * maxCutPct * muRealloc) / 100);
            if (amountCents > 0) {
              const reallocSrcBudget = currentBudgetCents - amountCents;
              const verdict = await checkGuardrails(
                shopId,
                {
                  kind: "reallocate_budget",
                  campaignId: c.campaign_id,
                  destCampaignId: dest.campaignId,
                  dollarImpactCents: amountCents,
                  campaignSpendCents: c.campaign_spend_cents,
                  currentBudgetCents,
                  newBudgetCents: reallocSrcBudget,
                },
                sb,
                { forceBypassOff: true, autonomous: true },
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
              if (res.outcome === "succeeded") {
                // Collect for await Promise.allSettled at end of run — prevents serverless abandonment.
                notifyPromises.push(
                  notifyAutonomousAction(
                    { shopId, actionDescription: `Reallocated budget from campaign ${c.campaign_id}` },
                    merchantEmail,
                  ).catch((e) => console.error("[autopilot-notify] unexpected error (realloc)", e)),
                );
              }
              continue;
            }
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
        { forceBypassOff: true, autonomous: true },
      );
      if (!verdict.allowed) {
        decide(c, kind, "blocked", verdict.reason ?? "blocked by guardrails");
        continue;
      }

      // I4: Freshness + live precondition re-check — runs AFTER graduation + guardrails
      // pass and BEFORE the executor fires. Fail-safe: a thrown check is ok:false,
      // so a DB hiccup can never silently permit an autonomous action.
      if (kind === "pause_campaign" || kind === "reduce_campaign_budget") {
        const precheck = await preconditionFresh({ kind, candidate: c, sb, nowMs: Date.now() });
        if (!precheck.ok) {
          console.info(`[autopilot] precondition re-check failed for ${c.campaign_id}: ${precheck.reason}`);
          decide(c, kind, "skipped", precheck.reason ?? "precondition_failed");
          continue;
        }
      }

      // I10: For sku_stockout_vs_spend → pause_campaign specifically, also require
      // the stockout allowlist to clear. The detector is NOT in PAUSE_DETECTORS today
      // (so it won't reach this path), but the gate is wired here so that IF it ever
      // appears as an autonomous pause candidate the allowlist is enforced. The check
      // ALWAYS returns ok:false in the current schema (inventory_policy not synced),
      // which is the correct conservative default — it queues for human review.
      if (kind === "pause_campaign" && c.detector_id === "sku_stockout_vs_spend") {
        // Load the raw alert so stockoutPauseAllowed can read entity_ref.
        const { data: alertRow } = await sb
          .from("alerts")
          .select("id, detector_id, entity_ref")
          .eq("id", c.alert_id)
          .maybeSingle();
        if (!alertRow) {
          decide(c, kind, "skipped", "stockout_allowlist: alert row not found");
          continue;
        }
        const stockCheck = await stockoutPauseAllowed({ shopId, alert: alertRow, sb });
        if (!stockCheck.ok) {
          console.info(`[autopilot] stockout allowlist blocked ${c.campaign_id}: ${stockCheck.reason}`);
          decide(c, kind, "skipped", stockCheck.reason ?? "stockout_precondition_not_met");
          continue;
        }
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
      if (res.outcome === "succeeded") {
        // Collect for await Promise.allSettled at end of run — prevents serverless abandonment.
        const actionLabel = kind === "pause_campaign" ? "Paused campaign" : "Reduced budget for campaign";
        notifyPromises.push(
          notifyAutonomousAction(
            { shopId, actionDescription: `${actionLabel} ${c.campaign_id}` },
            merchantEmail,
          ).catch((e) => console.error("[autopilot-notify] unexpected error (pause/reduce)", e)),
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[autopilot] candidate ${c.campaign_id} (alert ${c.alert_id}) errored: ${msg}`);
      decide(c, null, "failed", `threw: ${msg}`);
    }
  }

  // Await all notification promises before returning so Vercel cron doesn't
  // abandon them when the response is sent. allSettled: a delivery failure
  // never affects the summary (the action already landed and was recorded).
  if (notifyPromises.length > 0) {
    await Promise.allSettled(notifyPromises);
  }

  return { skipped: false, acted, blocked, failed, considered: decisions.length, blockedReasons, decisions };

  } finally {
    // I6: Always release the per-shop lock on completion OR error. The TTL
    // (LOCK_TTL_MS) acts as a backstop if this finally somehow doesn't run.
    await releaseAutopilotLock(shopId, sb);
  }
}
