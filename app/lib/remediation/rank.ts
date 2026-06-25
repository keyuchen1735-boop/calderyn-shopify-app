// app/lib/remediation/rank.ts
import type { DetectorId } from "../types";
import type { MoveKind, RemediationInput, RemediationPlan, StrategicMove } from "./types";

/** Coerce a raw evidence record (values may be strings, numbers, or null) into
 *  numbers. Non-numeric / missing values become null. Pure. */
export function toNumericEvidence(
  ev: Record<string, unknown>,
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(ev ?? {})) {
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    out[k] = Number.isFinite(n) ? n : null;
  }
  return out;
}

const MOVE_LABELS: Record<MoveKind, string> = {
  discontinue: "Stop reordering this product",
  reallocate_to_winner: "Move ad budget to a higher-margin product",
  cut_ads: "Cut the ad spend driving the loss",
  fix_returns: "Fix the return driver before scaling",
  review_pricing: "Raise price or renegotiate cost",
  snooze: "Snooze",
};

// Deterministic tie-break when two moves have equal projected impact. Lower
// index wins. discontinue first (most decisive), snooze last.
const MOVE_PRIORITY: MoveKind[] = [
  "discontinue",
  "reallocate_to_winner",
  "fix_returns",
  "cut_ads",
  "review_pricing",
  "snooze",
];

const PRODUCT_ECON_DETECTORS: ReadonlySet<DetectorId> = new Set<DetectorId>([
  "negative_unit_economics",
  "ad_tax_overload",
  "return_rate_hidden_loss",
  "margin_erosion",
  "cogs_drift",
]);

/** Per-unit gross margin at ZERO ad spend (price − COGS − ship), per detector.
 *  Returns null when no per-unit margin is on the evidence. */
function grossUnitMarginUsd(d: DetectorId, ev: Record<string, number | null>): number | null {
  switch (d) {
    case "negative_unit_economics":
      return ev.gross_unit_margin_usd;
    case "return_rate_hidden_loss":
      return ev.unit_margin_usd;
    case "margin_erosion":
      return ev.current_unit_margin_usd ?? ev.unit_margin_usd;
    default:
      return null;
  }
}

/** Is the product unprofitable even before any ad spend? When we lack a per-unit
 *  margin, fall back to the 7-day gross profit sign (ad_tax_overload / cogs_drift
 *  carry gross_profit_7d_usd). Unknown → treat as not dead (advisory). */
function isStructurallyDead(d: DetectorId, ev: Record<string, number | null>): boolean {
  const m = grossUnitMarginUsd(d, ev);
  if (m != null) return m <= 0;
  if (ev.gross_profit_7d_usd != null) return ev.gross_profit_7d_usd <= 0;
  return false;
}

const AD_DRIVEN: ReadonlySet<DetectorId> = new Set<DetectorId>([
  "negative_unit_economics",
  "ad_tax_overload",
]);

function move(kind: MoveKind, dollarImpactCents: number): StrategicMove {
  return {
    kind,
    dollarImpactCents,
    executor:
      kind === "snooze"
        ? "snooze_alert"
        : kind === "discontinue"
          ? "discontinue_sku"
          : null,
    // fix_returns has no automatable executor (returns are a product / listing /
    // QA fix) and is never enriched — give it a standing reason so it never
    // renders as a bare label (rule 12). WS4 turns this into an advisory deep-link.
    ineligibleReason:
      kind === "fix_returns"
        ? "returns need a product or listing change — no one-click fix"
        : undefined,
    label: MOVE_LABELS[kind],
  };
}

export function rankMoves(input: RemediationInput): RemediationPlan {
  const { detectorId: d, dollarImpactCents: impact, evidence: ev } = input;

  // Non-product-economics detectors get no plan (caller falls back to legacy
  // action logic). Defensive: the server only calls this for the 5 in scope.
  if (!PRODUCT_ECON_DETECTORS.has(d)) {
    return { moves: [move("snooze", 0)], recommended: null, structurallyDead: false };
  }

  const structurallyDead = isStructurallyDead(d, ev);
  const moves: StrategicMove[] = [];

  if (structurallyDead) {
    // Can't be fixed by tuning ads — stopping it saves the whole modeled loss.
    moves.push(move("discontinue", impact));
  } else {
    if (AD_DRIVEN.has(d)) {
      // Viable product, ads are the bleed: reallocate keeps the margin AND earns
      // on a winner; cut_ads is the simpler fallback. Equal $ recovered → the
      // tie-break makes reallocate the recommendation.
      moves.push(move("reallocate_to_winner", impact));
      moves.push(move("cut_ads", impact));
    }
    if (d === "return_rate_hidden_loss") {
      const ret = ev.return_30d_usd;
      moves.push(move("fix_returns", ret != null ? Math.round(ret * 100) : impact));
    }
    if ((d === "margin_erosion" || d === "cogs_drift") && moves.length === 0) {
      moves.push(move("review_pricing", impact));
    }
  }

  moves.push(move("snooze", 0));

  moves.sort(
    (a, b) =>
      b.dollarImpactCents - a.dollarImpactCents ||
      MOVE_PRIORITY.indexOf(a.kind) - MOVE_PRIORITY.indexOf(b.kind),
  );

  const recommended = moves.find((m) => m.kind !== "snooze")?.kind ?? null;
  return { moves, recommended, structurallyDead };
}
