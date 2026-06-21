// Auto-pilot: for an opted-in shop, scan open money-losing alerts and act within
// guardrails, attributing every action to "autopilot". Reads candidates from the
// v_autopilot_candidates view (alert + campaign + 7d spend + current budget).

import type { SupabaseClient } from "@supabase/supabase-js";
import { checkGuardrails } from "./guardrails.server";
import { executeAction, type ExecutableKind } from "./execute.server";
import { executeReallocation } from "./reallocate.server";
import {
  loadReallocationCandidates,
  pickReallocation,
} from "./reallocation-suggest.server";
import { DETECTOR_LABELS } from "../labels";
import { rankMoves, toNumericEvidence } from "../remediation/rank";
import { enrichRemediation } from "../remediation/enrich.server";
import type { MoveKind, StrategicMove } from "../remediation/types";
import { remediationReason } from "./remediation-reason";
import { checkSkuGuardrails } from "./remediation-guard.server";
import { executeDiscontinueAlertAction } from "./alert-action.server";
import { executeReallocateSpendSku } from "./reallocate-sku.server";
import { calderynClient } from "../calderyn.server";
import type { Alert, DetectorId } from "../types";

const PAUSE_DETECTORS = new Set([
  "campaign_below_breakeven",
  "negative_unit_economics",
]);
const BUDGET_DETECTORS = new Set(["ad_tax_overload"]);
const SCALE_DETECTORS = new Set(["campaign_scaling_opportunity"]);
const DEFAULT_MAX_CUT_PCT = 50; // mirrors the config default; the guardrail check enforces the live value
const DEFAULT_MAX_INCREASE_PCT = 20;

const PRODUCT_ECON_DETECTORS = new Set<DetectorId>([
  "negative_unit_economics",
  "ad_tax_overload",
  "return_rate_hidden_loss",
  "margin_erosion",
  "cogs_drift",
]);

export interface AutopilotSummary {
  skipped: boolean;
  acted: number;
  blocked: number;
  /** Remediation recommendations that were advisory/non-executable and not acted
   *  on (distinct from `blocked`, which is a guardrail/cap/precondition refusal). */
  skippedMoves: number;
  /** Candidates whose action threw (DB/ownership/insert error). Counted, logged,
   *  and skipped so the run keeps draining the rest; retriable platform failures
   *  are handled separately by the action-retry cron, not here. */
  failed: number;
}

interface Candidate {
  alert_id: string;
  detector_id: string;
  dollar_impact: number; // dollars
  campaign_id: string | null; // nullable: SKU-only economics alerts have no campaign
  campaign_spend_cents: number;
  daily_budget_cents: number | null;
  // New (Task 3 view): for the remediation plan + SKU targeting.
  evidence: Record<string, unknown> | null;
  sku: string | null;
  sku_id: string | null;
}

// Maps a plan move's executor to a guarded execution. Returns "acted" |
// "blocked" | "skipped" | "fell_through". "fell_through" means "not an
// executable remediation move — let the legacy campaign logic handle it".
type RemediationOutcome = "acted" | "blocked" | "skipped" | "fell_through";

/** Try to act on the candidate's stored remediation recommendation. Returns
 *  whether it acted/blocked/skipped, or "fell_through" to defer to the legacy
 *  campaign logic. The decision is the Phase-1 plan + the Phase-3 enrichment —
 *  we never re-rank or re-resolve the winner/campaign here (re-deriving would
 *  drift from the merchant path, which routes the *same* enriched move). */
async function tryRemediation(
  shopId: string,
  c: Candidate,
  sb: SupabaseClient,
): Promise<RemediationOutcome> {
  if (!PRODUCT_ECON_DETECTORS.has(c.detector_id as DetectorId)) return "fell_through";

  // Reuse the Phase-1 engine on the candidate's own evidence — identical input
  // to attachRemediation(), so autopilot and the UI agree on the recommendation.
  const dollarImpactCentsAlert = Math.round(Number(c.dollar_impact) * 100);
  const basePlan = rankMoves({
    detectorId: c.detector_id as DetectorId,
    dollarImpactCents: dollarImpactCentsAlert,
    evidence: toNumericEvidence(c.evidence ?? {}),
  });

  // Phase-3 enrichment fills the executable target + flips executor null →
  // "reallocate_spend_sku"/cut kinds. Phase 4 calls the SAME resolver the
  // merchant detail paths call — it does NOT re-derive the winner/campaign
  // itself (re-deriving here would drift from the merchant path). enrich takes
  // an Alert-shaped object; the candidate row carries everything it reads
  // (id, detector_id, dollar_impact, evidence with sku_id).
  const alertForEnrich = {
    id: c.alert_id,
    detector_id: c.detector_id as DetectorId,
    dollar_impact: dollarImpactCentsAlert,
    evidence: { ...(c.evidence ?? {}), sku_id: c.sku_id ?? undefined },
  } as unknown as Alert;
  const plan = await enrichRemediation(alertForEnrich, basePlan, sb, shopId);

  const recommended = plan.recommended;
  if (!recommended) {
    // Only snooze applies → nothing to automate. Surface, don't drop (rule 12).
    console.info(`[autopilot] remediation skip on alert ${c.alert_id}: no recommended move`);
    return "skipped";
  }
  const move: StrategicMove | undefined = plan.moves.find((m) => m.kind === recommended);

  // Advisory / not-yet-executable recommendation (executor null, or snooze):
  // autopilot does not auto-snooze and does not act on advisory moves. This
  // includes a reallocate_to_winner that enrichRemediation left advisory
  // (no dedicated campaign / no winner → executor stayed null). Fall through so
  // the legacy campaign logic can still pause/reduce if applicable.
  if (!move || move.executor == null || move.executor === "snooze_alert") {
    console.info(
      `[autopilot] remediation skip on alert ${c.alert_id}: recommended ${recommended} is advisory/non-executable`,
    );
    return "fell_through";
  }

  const dollarImpactCents = move.dollarImpactCents;
  const reason = remediationReason(plan, recommended as MoveKind, c.detector_id as DetectorId);
  const idempotencyKey = `autopilot:${c.alert_id}:${move.executor}`;

  // SKU-scoped move (discontinue_sku): SKU guard, no campaign needed. The Phase-2
  // gateway takes a single opts object with a `client` (slice of calderynClient)
  // and a Shopify `admin` client; it re-derives the product GID from the alert's
  // own SKU record (never request input). Autopilot passes the alert id + reason.
  if (move.executor === "discontinue_sku") {
    if (!c.sku_id) {
      console.info(`[autopilot] remediation block on alert ${c.alert_id}: discontinue_sku has no sku_id`);
      return "blocked";
    }
    const verdict = await checkSkuGuardrails(shopId, { dollarImpactCents }, sb);
    if (!verdict.allowed) {
      console.info(`[autopilot] remediation block on alert ${c.alert_id}: ${verdict.reason}`);
      return "blocked";
    }
    const client = calderynClient(shopId);
    const { admin } = await (await import("~/shopify.server")).unauthenticated.admin(shopId);
    await executeDiscontinueAlertAction({
      client,
      admin,
      sb,
      shopId,
      alertId: c.alert_id,
      kind: "discontinue_sku",
      idempotencyKey,
      actor: "autopilot",
      triggerReason: reason,
    });
    return "acted";
  }

  // Campaign-scoped remediation moves: reallocate_spend_sku, or a plain cut via
  // pause/reduce. These need a campaign; without one, block (rule 12 — the
  // engine should not have offered an executable campaign move with no campaign).
  if (!c.campaign_id) {
    console.info(`[autopilot] remediation block on alert ${c.alert_id}: ${move.executor} needs a campaign`);
    return "blocked";
  }

  // SKU budget shift: route to the Phase-3 SKU gateway. It re-runs
  // enrichRemediation server-side to re-resolve the loser→winner pair from the
  // trusted alert (it does NOT trust client-supplied campaign ids), then
  // delegates to the shipped executeReallocation. Autopilot passes only the
  // alert id + idempotency key + reason; the enriched `target` we read above is
  // used solely to confirm executor === "reallocate_spend_sku" before routing.
  if (move.executor === "reallocate_spend_sku") {
    const verdict = await checkSkuGuardrails(shopId, { dollarImpactCents }, sb);
    if (!verdict.allowed) {
      console.info(`[autopilot] remediation block on alert ${c.alert_id}: ${verdict.reason}`);
      return "blocked";
    }
    const client = calderynClient(shopId);
    await executeReallocateSpendSku({
      client,
      sb,
      shopId,
      alertId: c.alert_id,
      idempotencyKey,
      actor: "autopilot",
      triggerReason: reason,
    });
    return "acted";
  }

  // Plain cut: pause_campaign / reduce_campaign_budget through the existing
  // campaign executor seam executeAction(shopId, ExecuteInput, sb) + the
  // campaign guard. triggerReason flows through ExecuteInput.triggerReason.
  if (move.executor === "pause_campaign" || move.executor === "reduce_campaign_budget") {
    const currentBudgetCents = c.daily_budget_cents ?? null;
    const newBudgetCents =
      move.executor === "reduce_campaign_budget" && currentBudgetCents != null
        ? Math.round(currentBudgetCents * 0.5) // mirror DEFAULT_MAX_CUT_PCT (guard enforces the live value)
        : undefined;
    if (move.executor === "reduce_campaign_budget" && !newBudgetCents) {
      console.info(`[autopilot] remediation block on alert ${c.alert_id}: no current budget to cut`);
      return "blocked";
    }
    const verdict = await checkGuardrails(
      shopId,
      {
        kind: move.executor,
        campaignId: c.campaign_id,
        dollarImpactCents,
        campaignSpendCents: c.campaign_spend_cents,
        currentBudgetCents: currentBudgetCents ?? undefined,
        newBudgetCents,
      },
      sb,
    );
    if (!verdict.allowed) {
      console.info(`[autopilot] remediation block on alert ${c.alert_id}: ${verdict.reason}`);
      return "blocked";
    }
    await executeAction(
      shopId,
      {
        alertId: c.alert_id,
        kind: move.executor,
        campaignId: c.campaign_id,
        idempotencyKey,
        dailyBudgetCents: newBudgetCents,
        actor: "autopilot",
        triggerReason: reason,
      },
      sb,
    );
    return "acted";
  }

  // Unknown executor union member — fail visibly rather than silently dropping.
  console.warn(`[autopilot] remediation skip on alert ${c.alert_id}: unhandled executor ${move.executor}`);
  return "skipped";
}

function autopilotReason(
  verb: string,
  detectorId: string,
  dollarImpact: number,
): string {
  const label =
    DETECTOR_LABELS[detectorId as keyof typeof DETECTOR_LABELS] ?? detectorId;
  const stake = Math.round(Number(dollarImpact) || 0).toLocaleString("en-US");
  return `${verb}: "${label}" — $${stake} at stake, within guardrails`;
}

export async function runAutopilotForShop(
  shopId: string,
  sb: SupabaseClient,
): Promise<AutopilotSummary> {
  const { data: cfg, error: cErr } = await sb
    .from("guardrail_config")
    .select(
      "autopilot_enabled, autopilot_max_budget_cut_pct, autopilot_max_budget_increase_pct, autopilot_max_daily_budget_cents",
    )
    .eq("shop_id", shopId)
    .maybeSingle();
  if (cErr) throw cErr;
  if (!cfg || !cfg.autopilot_enabled)
    return { skipped: true, acted: 0, blocked: 0, skippedMoves: 0, failed: 0 };

  const maxCutPct = Number(
    cfg.autopilot_max_budget_cut_pct ?? DEFAULT_MAX_CUT_PCT,
  );
  const maxIncreasePct = Number(
    cfg.autopilot_max_budget_increase_pct ?? DEFAULT_MAX_INCREASE_PCT,
  );
  const maxDailyBudgetCents =
    cfg.autopilot_max_daily_budget_cents == null
      ? null
      : Number(cfg.autopilot_max_daily_budget_cents);

  const { data: rows, error: aErr } = await sb
    .from("v_autopilot_candidates")
    .select(
      "alert_id, detector_id, dollar_impact, campaign_id, campaign_spend_cents, daily_budget_cents, evidence, sku, sku_id",
    )
    .eq("shop_id", shopId)
    .order("dollar_impact", { ascending: false });
  if (aErr) throw aErr;
  const candidates = (rows ?? []) as Candidate[];

  // Defensive actions (pause/reduce/reallocate) take priority over offensive
  // scale-ups so loss-prevention is never starved of the daily action cap by a
  // bigger-dollar scale opportunity. Each subgroup keeps its dollar_impact order.
  const ordered = [
    ...candidates.filter((c) => !SCALE_DETECTORS.has(c.detector_id)),
    ...candidates.filter((c) => SCALE_DETECTORS.has(c.detector_id)),
  ];

  // Hoisted: ONE candidate-pool read serves every reallocation decision this
  // run, instead of re-reading campaign + grade facts per candidate.
  const gradedPool = candidates.some((c) => BUDGET_DETECTORS.has(c.detector_id))
    ? await loadReallocationCandidates(shopId, sb)
    : [];

  let acted = 0;
  let blocked = 0;
  let skippedMoves = 0;
  let failed = 0;
  for (const c of ordered) {
    try {
      const rem = await tryRemediation(shopId, c, sb);
      if (rem === "acted") { acted += 1; continue; }
      if (rem === "blocked") { blocked += 1; continue; }
      if (rem === "skipped") { skippedMoves += 1; continue; }
      // rem === "fell_through": legacy campaign logic below.

      let kind: ExecutableKind | null = null;
      if (PAUSE_DETECTORS.has(c.detector_id)) kind = "pause_campaign";
      else if (BUDGET_DETECTORS.has(c.detector_id))
        kind = "reduce_campaign_budget";
      else if (SCALE_DETECTORS.has(c.detector_id))
        kind = "increase_campaign_budget";
      if (!kind) continue;

      // Legacy campaign logic requires a non-null campaign_id. A fell-through
      // candidate without one (data gap in the view) is blocked, not silently
      // dropped (rule 12).
      if (!c.campaign_id) {
        console.info(
          `[autopilot] blocked legacy action on alert ${c.alert_id}: ${kind} requires campaign_id`,
        );
        blocked += 1;
        continue;
      }
      const campaignId: string = c.campaign_id;

      const currentBudgetCents = c.daily_budget_cents ?? null;

      if (kind === "increase_campaign_budget") {
        if (!currentBudgetCents) {
          console.info(
            `[autopilot] blocked scale on ${c.campaign_id}: current daily budget is ${
              currentBudgetCents == null ? "missing from sync" : "$0"
            }`,
          );
          blocked += 1;
          continue;
        }
        let target = Math.round(
          currentBudgetCents * (1 + maxIncreasePct / 100),
        );
        if (maxDailyBudgetCents != null)
          target = Math.min(target, maxDailyBudgetCents);
        if (target <= currentBudgetCents) {
          console.info(
            `[autopilot] skipped scale on ${c.campaign_id}: already at/above the daily ceiling`,
          );
          blocked += 1;
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
          blocked += 1;
          continue;
        }
        await executeAction(
          shopId,
          {
            alertId: c.alert_id,
            kind: "increase_campaign_budget",
            campaignId: c.campaign_id,
            idempotencyKey: `autopilot:${c.alert_id}:increase_campaign_budget`,
            dailyBudgetCents: target,
            actor: "autopilot",
            triggerReason: autopilotReason(
              "Auto scale budget",
              c.detector_id,
              c.dollar_impact,
            ),
          },
          sb,
        );
        acted += 1;
        continue;
      }

      // A budget cut needs a known current budget to cut from. executeAction
      // refuses a missing/zero target budget (it would otherwise zero the live
      // campaign), and an uncaught throw here would abort the whole run — so
      // count it blocked and keep draining the remaining candidates.
      if (kind === "reduce_campaign_budget" && !currentBudgetCents) {
        // Distinguish "no budget synced" from "budget is $0 on the platform" in
        // the logs — both block, but they have different operator fixes.
        console.info(
          `[autopilot] blocked budget cut on ${c.campaign_id}: current daily budget is ${
            currentBudgetCents == null
              ? "missing from sync"
              : "$0 on the platform"
          }`,
        );
        blocked += 1;
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
        console.warn(
          `[autopilot] blocked budget cut on ${c.campaign_id}: max_budget_cut_pct=${maxCutPct} computes a $0 target budget`,
        );
        blocked += 1;
        continue;
      }

      // Budget detectors: prefer REDIRECTING the cut to a winning campaign on
      // another platform over shrinking total spend. Falls back to the plain
      // reduction below when no destination exists. A guardrail-blocked
      // reallocation does NOT fall through to reduce — same alert, same day,
      // one decision (counted as blocked).
      if (
        kind === "reduce_campaign_budget" &&
        currentBudgetCents != null &&
        newBudgetCents != null
      ) {
        const amountCents = currentBudgetCents - newBudgetCents;
        if (amountCents > 0) {
          const { dest } = pickReallocation(gradedPool, {
            sourceCampaignId: c.campaign_id,
          });
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
              blocked += 1;
              continue;
            }
            await executeReallocation(
              shopId,
              {
                alertId: c.alert_id,
                sourceCampaignId: c.campaign_id,
                destCampaignId: dest.campaignId,
                amountCents,
                idempotencyKey: `autopilot:${c.alert_id}:reallocate_budget`,
                actor: "autopilot",
                triggerReason: autopilotReason(
                  "Auto reallocate budget",
                  c.detector_id,
                  c.dollar_impact,
                ),
              },
              sb,
            );
            acted += 1;
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
        blocked += 1;
        continue;
      }

      await executeAction(
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
      acted += 1;
    } catch (err) {
      // A throw here (DB/ownership/insert error in checkGuardrails or an
      // executor) must not abort the run — log it, count it, and move to the
      // next alert. Retriable platform failures are already parked as
      // `retrying` by executeAction for the action-retry cron, so there is
      // nothing to retry inline; we just stop one bad alert from starving the rest.
      console.error(
        `[autopilot] action failed for alert ${c.alert_id} (detector ${c.detector_id}, campaign ${c.campaign_id}); skipping to next`,
        err,
      );
      failed += 1;
    }
  }

  return { skipped: false, acted, blocked, skippedMoves, failed };
}
