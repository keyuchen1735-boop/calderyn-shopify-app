// Auto-pilot: for an opted-in shop, scan open money-losing alerts and act within
// guardrails, attributing every action to "autopilot". Reads candidates from the
// v_autopilot_candidates view (alert + campaign + 7d spend + current budget).

import type { SupabaseClient } from "@supabase/supabase-js";
import { checkGuardrails } from "./guardrails.server";
import { executeAction, type ExecutableKind } from "./execute.server";
import { executeReallocation } from "./reallocate.server";
import { loadReallocationCandidates, pickReallocation } from "./reallocation-suggest.server";

const PAUSE_DETECTORS = new Set(["campaign_below_breakeven", "negative_unit_economics"]);
const BUDGET_DETECTORS = new Set(["ad_tax_overload"]);
const DEFAULT_MAX_CUT_PCT = 50; // mirrors the config default; the guardrail check enforces the live value

export interface AutopilotSummary {
  skipped: boolean;
  acted: number;
  blocked: number;
}

interface Candidate {
  alert_id: string;
  detector_id: string;
  dollar_impact: number; // dollars
  campaign_id: string;
  campaign_spend_cents: number;
  daily_budget_cents: number | null;
}

export async function runAutopilotForShop(shopId: string, sb: SupabaseClient): Promise<AutopilotSummary> {
  const { data: cfg, error: cErr } = await sb
    .from("guardrail_config")
    .select("autopilot_enabled, autopilot_max_budget_cut_pct")
    .eq("shop_id", shopId)
    .maybeSingle();
  if (cErr) throw cErr;
  if (!cfg || !cfg.autopilot_enabled) return { skipped: true, acted: 0, blocked: 0 };

  const maxCutPct = Number(cfg.autopilot_max_budget_cut_pct ?? DEFAULT_MAX_CUT_PCT);

  const { data: rows, error: aErr } = await sb
    .from("v_autopilot_candidates")
    .select("alert_id, detector_id, dollar_impact, campaign_id, campaign_spend_cents, daily_budget_cents")
    .eq("shop_id", shopId)
    .order("dollar_impact", { ascending: false });
  if (aErr) throw aErr;
  const candidates = (rows ?? []) as Candidate[];

  // Hoisted: ONE candidate-pool read serves every reallocation decision this
  // run, instead of re-reading campaign + grade facts per candidate.
  const gradedPool = candidates.some((c) => BUDGET_DETECTORS.has(c.detector_id))
    ? await loadReallocationCandidates(shopId, sb)
    : [];

  let acted = 0;
  let blocked = 0;
  for (const c of candidates) {
    let kind: ExecutableKind | null = null;
    if (PAUSE_DETECTORS.has(c.detector_id)) kind = "pause_campaign";
    else if (BUDGET_DETECTORS.has(c.detector_id)) kind = "reduce_campaign_budget";
    if (!kind) continue;

    const currentBudgetCents = c.daily_budget_cents ?? null;

    // A budget cut needs a known current budget to cut from. executeAction
    // refuses a missing/zero target budget (it would otherwise zero the live
    // campaign), and an uncaught throw here would abort the whole run — so
    // count it blocked and keep draining the remaining candidates.
    if (kind === "reduce_campaign_budget" && !currentBudgetCents) {
      // Distinguish "no budget synced" from "budget is $0 on the platform" in
      // the logs — both block, but they have different operator fixes.
      console.info(
        `[autopilot] blocked budget cut on ${c.campaign_id}: current daily budget is ${
          currentBudgetCents == null ? "missing from sync" : "$0 on the platform"
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
      },
      sb,
    );
    acted += 1;
  }

  return { skipped: false, acted, blocked };
}
