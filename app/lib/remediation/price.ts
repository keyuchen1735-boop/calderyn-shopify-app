// app/lib/remediation/price.ts
// Pure suggested-price computation for the adjust_price action. No server
// imports — importable from client, server, and autopilot like the rest of the
// remediation module. Restores a SKU's own pre-erosion dollar margin; never
// lowers price; clamps the raise to a guardrail percentage.
import type { DetectorId } from "../types";

export interface AdjustPriceInput {
  detectorId: DetectorId;
  /** Evidence coerced to numbers (USD dollars), nulls for missing keys. */
  evidence: Record<string, number | null>;
  /** Current Shopify variant price, cents. */
  currentPriceCents: number;
  /** Current open COGS, cents (null when unknown). */
  currentCogsCents: number | null;
  /** Max single-step price change, whole percent (e.g. 15). */
  capPct: number;
}

export interface AdjustPriceSuggestion {
  /** Suggested new price, cents. Always > currentPriceCents (a raise). */
  newPriceCents: number;
  /** True when the raise was clamped to the guardrail cap. */
  capped: boolean;
  /** Which detector basis produced the target. */
  basis: "margin_erosion" | "cogs_drift";
}

export function suggestAdjustPrice(input: AdjustPriceInput): AdjustPriceSuggestion | null {
  const { detectorId, evidence, currentPriceCents, currentCogsCents, capPct } = input;

  // Need a real current price to anchor the raise and the cap.
  if (!Number.isFinite(currentPriceCents) || currentPriceCents <= 0) return null;

  let target: number | null = null;
  if (detectorId === "margin_erosion") {
    // Restore COGS + the baseline per-unit margin from before the erosion.
    const baselineMarginUsd = evidence.baseline_unit_margin_usd;
    if (currentCogsCents != null && baselineMarginUsd != null) {
      target = currentCogsCents + Math.round(baselineMarginUsd * 100);
    }
  } else if (detectorId === "cogs_drift") {
    // Pass the per-unit cost increase through: the prior margin is restored by
    // raising price by exactly the cost delta (price itself hasn't moved).
    const prior = evidence.prior_unit_cost_usd;
    const current = evidence.current_unit_cost_usd;
    if (prior != null && current != null) {
      target = currentPriceCents + Math.round((current - prior) * 100);
    }
  }
  if (target == null) return null;

  // Raise or hold, never auto-cut: nothing to recommend if the target isn't a raise.
  if (target <= currentPriceCents) return null;

  // Clamp the raise to ±capPct of the current price.
  const maxCents = Math.round(currentPriceCents * (1 + capPct / 100));
  const capped = target > maxCents;
  const newPriceCents = capped ? maxCents : target;

  return { newPriceCents, capped, basis: detectorId as "margin_erosion" | "cogs_drift" };
}
