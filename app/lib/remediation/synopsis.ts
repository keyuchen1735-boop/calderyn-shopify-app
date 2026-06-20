// app/lib/remediation/synopsis.ts
import type { DetectorId } from "../types";
import type { RemediationInput, RemediationPlan } from "./types";

// Money/percent formatters local to the engine so this stays pure (no UI deps).
function usd(n: number | null | undefined): string {
  if (n == null) return "$0";
  const neg = n < 0;
  const s = "$" + Math.round(Math.abs(n)).toLocaleString("en-US");
  return neg ? "-" + s : s;
}
function pct(frac: number | null | undefined): string {
  if (frac == null) return "0%";
  // return_rate arrives as a 0..1 fraction; ratios too.
  return Math.round(frac * 100) + "%";
}

/** One or two plain sentences: what's wrong + the recommended move. Deterministic
 *  template per (detector, structurallyDead). Never empty (rule 12). */
export function synopsisFor(plan: RemediationPlan, input: RemediationInput): string {
  const ev = input.evidence;
  const d: DetectorId = input.detectorId;

  if (plan.structurallyDead) {
    return (
      `This product loses money on every sale even before ad spend — ` +
      `reordering it just funds the loss. Stop restocking it and clear what's left.`
    );
  }

  switch (d) {
    case "negative_unit_economics":
      return (
        `This product makes ${usd(ev.gross_unit_margin_usd)} a unit — it isn't the problem. ` +
        `You're paying ${usd(ev.cac_per_unit_usd)} in ads per sale, so each order nets ` +
        `${usd(ev.net_per_unit_usd)}. Cut or move that ad spend; the product is fine.`
      );
    case "ad_tax_overload":
      return (
        `Ads eat ${pct(ev.ad_tax_ratio)} of this product's revenue ` +
        `(${usd(ev.ad_spend_7d_usd)} spent against ${usd(ev.revenue_7d_usd)} in sales). ` +
        `Cut the spend or move it to a higher-ROAS product.`
      );
    case "return_rate_hidden_loss":
      return (
        `${pct(ev.return_rate)} of these come back, erasing ${usd(ev.return_30d_usd)} of margin ` +
        `that the top-line hides. Fix the return driver (sizing, photos, quality) before scaling — ` +
        `or pull ads on it until it's fixed.`
      );
    case "margin_erosion":
      return (
        `Margin slipped from ${usd(ev.baseline_unit_margin_usd)} to ` +
        `${usd(ev.current_unit_margin_usd)} a unit. Raise the price or renegotiate cost ` +
        `before it turns negative.`
      );
    case "cogs_drift":
      return (
        `Unit cost rose from ${usd(ev.prior_unit_cost_usd)} to ${usd(ev.current_unit_cost_usd)} ` +
        `(${pct(ev.drift_pct)}), thinning every sale. Re-price or renegotiate COGS.`
      );
    default:
      return `Review this product's unit economics — it's losing margin.`;
  }
}
