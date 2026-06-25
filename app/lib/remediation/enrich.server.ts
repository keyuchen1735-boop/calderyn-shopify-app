// app/lib/remediation/enrich.server.ts
// Async enrichment for the product-economics remediation plan (Phase 3). The
// ranking decision (rank.ts) stays PURE; this fills the winner/campaign target
// and flips reallocate_to_winner / cut_ads from advisory (null executor) to
// executable — but ONLY when eligible (rule 12: never a dead button). Reads one
// row from v_sku_remediation_inputs for the loser SKU plus the catalog winner
// pool. Server-only: imports Supabase types.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Alert } from "../types";
import type { RemediationPlan, StrategicMove } from "./types";
import { toNumericEvidence } from "./rank";

interface SkuRemediationRow {
  sku_id: string;
  title?: string | null;
  contribution_per_unit_cents: number | null;
  dedicated_campaign_id: string | null;
  dedicated_campaign_platform: string | null;
  dedicated_campaign_budget_cents: number | null;
  winner_rank?: number | null;
}

// Fraction of the loser's dedicated-campaign daily budget to shift to the
// winner. Must leave the source above zero (executeReallocation rejects
// amount >= source budget); 0.5 is well clear and matches the autopilot cut feel.
const SHIFT_FRACTION = 0.5;

// Below this daily budget, a percentage cut is pointless → pause outright.
const REDUCE_FLOOR_CENTS = 1000;

/**
 * Enrich a remediation plan with live SKU->campaign resolution. Returns a NEW
 * plan (does not mutate the input). A missing sku_id, missing view row, no
 * dedicated campaign, no qualifying winner, or a cross-platform winner all leave
 * the reallocate move advisory with an ineligibleReason. Best-effort: any DB
 * error logs and returns the plan unchanged (the advisory plan still renders).
 *
 * Both `reallocate_to_winner` and `cut_ads` are enriched in a single pass on the
 * same in-progress plan object — no closure clobbering (Task 4).
 */
export async function enrichRemediation(
  alert: Alert,
  plan: RemediationPlan,
  sb: SupabaseClient,
  shopId: string,
): Promise<RemediationPlan> {
  // margin_erosion / cogs_drift plans carry review_pricing instead of the
  // ad-driven moves — flip it to an executable adjust_price button when the SKU
  // has a linked variant AND the evidence shows a raise is warranted.
  const reviewIdx = plan.moves.findIndex((m) => m.kind === "review_pricing");
  if (reviewIdx >= 0) return enrichReviewPricing(alert, plan, reviewIdx, sb, shopId);

  const reallocIdx = plan.moves.findIndex((m) => m.kind === "reallocate_to_winner");
  if (reallocIdx < 0) return plan; // nothing to enrich (e.g. discontinue/fix_returns plan)

  const cutIdx = plan.moves.findIndex((m) => m.kind === "cut_ads");

  // The loser's SKU: v_alerts_view evidence carries sku_id for some detectors,
  // but others (e.g. negative_unit_economics) expose only margins — fall back to
  // the SKU code, which v_sku_remediation_inputs also keys on. Without either we
  // can't resolve the SKU; leave the moves advisory (rule 12).
  const skuId = typeof alert.evidence?.sku_id === "string" ? alert.evidence.sku_id : null;
  const skuCode = typeof alert.sku === "string" && alert.sku ? alert.sku : null;

  // advisory patches reallocate on the given base plan, leaving cut_ads as-is on
  // that base. Callers pass `plan` when cut_ads is also ineligible, or `enriched`
  // (with cut_ads already patched) when cut_ads is executable but reallocate is not.
  const advisory = (base: RemediationPlan, reason: string): RemediationPlan =>
    withMove(base, reallocIdx, (m) => ({
      ...m,
      executor: null,
      ineligibleReason: reason,
    }));

  if (!skuId && !skuCode) return plan; // no key to resolve the SKU

  // Hoisted above the try so the catch can fall back to the partially-enriched
  // plan: if the winner query fails AFTER cut_ads was made executable, we must
  // not discard that already-valid button (rule 12).
  let enriched = plan;

  try {
    const loserSel = sb
      .from("v_sku_remediation_inputs")
      .select(
        "sku_id, contribution_per_unit_cents, dedicated_campaign_id, dedicated_campaign_platform, dedicated_campaign_budget_cents",
      )
      .eq("shop_id", shopId);
    const { data: loser, error: lErr } = await (
      skuId ? loserSel.eq("sku_id", skuId) : loserSel.eq("sku", skuCode!)
    ).maybeSingle();
    if (lErr) throw lErr;

    const loserRow = loser as SkuRemediationRow | null;
    if (!loserRow) {
      return advisory(plan, "campaign data unavailable — no attribution found for this SKU");
    }
    if (!loserRow.dedicated_campaign_id || loserRow.dedicated_campaign_budget_cents == null) {
      return advisory(plan, "served by a shared campaign — exclude this SKU inside Advantage+ instead");
    }
    if (loserRow.dedicated_campaign_platform !== "meta") {
      return advisory(plan, "budget shift is Meta-only — adjust this campaign in its platform");
    }

    // The loser has a dedicated mutable Meta campaign. Enrich cut_ads now — it
    // is executable regardless of whether a winner exists. Both moves are patched
    // on the same in-progress plan object; no closure clobbering.
    const cutKind: StrategicMove["executor"] =
      loserRow.dedicated_campaign_budget_cents < REDUCE_FLOOR_CENTS
        ? "pause_campaign"
        : "reduce_campaign_budget";

    if (cutIdx >= 0) {
      enriched = withMove(enriched, cutIdx, (m) => ({
        ...m,
        executor: cutKind,
        ineligibleReason: undefined,
        target: {
          skuId: loserRow.sku_id,
          loserCampaignId: loserRow.dedicated_campaign_id!,
          loserCampaignBudgetCents: loserRow.dedicated_campaign_budget_cents ?? undefined,
        },
      }));
    }

    // Top catalog winner with its own dedicated mutable campaign, excluding the
    // loser SKU. winner_rank ascends (1 = best); take the first.
    const { data: winners, error: wErr } = await sb
      .from("v_sku_remediation_inputs")
      .select("sku_id, title, winner_rank, dedicated_campaign_id, dedicated_campaign_platform, dedicated_campaign_budget_cents")
      .eq("shop_id", shopId)
      .not("winner_rank", "is", null)
      .order("winner_rank", { ascending: true })
      .limit(5);
    if (wErr) throw wErr;

    const winner = ((winners ?? []) as SkuRemediationRow[]).find(
      (w) => w.sku_id !== loserRow.sku_id && w.dedicated_campaign_id,
    );
    if (!winner) return advisory(enriched, "no qualifying winner — no higher-margin product with stock headroom and a scalable campaign");
    if (winner.dedicated_campaign_platform !== "meta") {
      return advisory(enriched, "winner runs on a different platform — budget shift must stay on Meta");
    }

    const amountCents = Math.max(1, Math.floor(loserRow.dedicated_campaign_budget_cents * SHIFT_FRACTION));

    return withMove(enriched, reallocIdx, (m) => ({
      ...m,
      executor: "reallocate_spend_sku",
      ineligibleReason: undefined,
      label: `Move ad budget to ${winner.title ?? "your top product"}`,
      target: {
        skuId: loserRow.sku_id,
        loserCampaignId: loserRow.dedicated_campaign_id!,
        winnerSkuId: winner.sku_id,
        winnerCampaignId: winner.dedicated_campaign_id!,
        winnerLabel: winner.title ?? undefined,
        amountCents,
      },
    }));
  } catch (err) {
    console.error(`[remediation] enrich failed for alert ${alert.id} (advisory fallback)`, err);
    return advisory(enriched, "couldn't resolve the campaign — review manually");
  }
}

/**
 * Flip the review_pricing move to an executable adjust_price button, or leave it
 * advisory with a reason. Eligible when: the alert has a SKU with a linked
 * Shopify variant AND the evidence shows a raise is warranted (margin_erosion
 * carries a baseline margin to restore; cogs_drift shows cost rose). The exact
 * new price is computed at execution time from the live price + COGS — here we
 * only decide whether the button can exist (rule 12: never a dead button).
 */
async function enrichReviewPricing(
  alert: Alert,
  plan: RemediationPlan,
  idx: number,
  sb: SupabaseClient,
  shopId: string,
): Promise<RemediationPlan> {
  const advisory = (reason: string): RemediationPlan =>
    withMove(plan, idx, (m) => ({ ...m, executor: null, ineligibleReason: reason }));

  if (!alert.sku) return advisory("no SKU linked to this alert");

  // Raise-plausible check, pure from evidence — avoids a Shopify read when the
  // margin already recovered or no cost increase needs passing through.
  const ev = toNumericEvidence(alert.evidence ?? {});
  const plausible =
    alert.detector_id === "margin_erosion"
      ? ev.baseline_unit_margin_usd != null
      : alert.detector_id === "cogs_drift"
        ? ev.prior_unit_cost_usd != null &&
          ev.current_unit_cost_usd != null &&
          ev.current_unit_cost_usd > ev.prior_unit_cost_usd
        : false;
  if (!plausible) return advisory("margin already at or above its prior level — no raise needed");

  try {
    const { data, error } = await sb
      .from("sku_dim")
      .select("id, external_id")
      .eq("shop_id", shopId)
      .eq("sku", alert.sku)
      .maybeSingle();
    if (error) throw error;
    const row = data as { id?: string; external_id?: string | null } | null;
    if (!row?.external_id) {
      return advisory("no linked Shopify variant — set the price in Shopify directly");
    }
    return withMove(plan, idx, (m) => ({
      ...m,
      executor: "adjust_price",
      ineligibleReason: undefined,
      label: "Raise price to restore margin",
      target: { skuId: row.id ? String(row.id) : undefined },
    }));
  } catch (err) {
    console.error(`[remediation] review_pricing enrich failed for alert ${alert.id} (advisory)`, err);
    return advisory("couldn't resolve the product — review manually");
  }
}

function withMove(
  plan: RemediationPlan,
  idx: number,
  fn: (m: StrategicMove) => StrategicMove,
): RemediationPlan {
  const moves = plan.moves.map((m, i) => (i === idx ? fn(m) : m));
  return { ...plan, moves };
}
