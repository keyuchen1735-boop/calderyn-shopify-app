// Pure confidence math for Calderyn Calibration. NO I/O, NO .server imports:
// this is the single source of truth for the formula, imported by the recompute
// job and (later slices) the synchronous approve/reject path and the dashboard.
// See docs/superpowers/specs/2026-06-20-calderyn-calibration-design.md sections 2-3.

import type { ActionKind } from "../types";

export type Tier = "reversible" | "hard_to_reverse" | "irreversible";

const WEIGHTS = { detection: 0.3, historical: 0.5, reversibility: 0.2 } as const;
const K_PRIOR = 8;
const NOBRAINER_BONUS = 1.3;
const PRIOR_CLAMP_MAX = 0.95;

/**
 * I8: Minimum confidence (0-100) for a NO_BRAINER pair regardless of how many
 * rejects have accumulated. This keeps no-brainers surfacing as "always ask"
 * even after reject-spam, preventing permanent self-disable.
 *
 * A floor of 20 means: always surface with at least 20% confidence so the pair
 * is never silently dropped from consideration. It does NOT prevent demotion
 * from autonomous to "always ask" — graduation still requires conf >= gradThreshold
 * (typically ~75). The floor only prevents the pair from reaching 0 (invisible).
 */
export const NO_BRAINER_CONF_FLOOR = 20;

// Static seed prior per reversibility tier when no peer baseline exists.
const REVERSIBILITY_BASE: Record<Tier, number> = {
  reversible: 0.55,
  hard_to_reverse: 0.35,
  irreversible: 0.2,
};

// The reversibility FACTOR (0..1) that feeds the blended score.
const REVERSIBILITY_FACTOR: Record<Tier, number> = {
  reversible: 1.0,
  hard_to_reverse: 0.5,
  irreversible: 0.2,
};

// Kinds with a real platform executor today. Kinds NOT here get GUARDRAIL_VETO=0
// (conf 0) in the recompute. Keep in sync with ExecutableKind in execute.server.ts.
export const HAS_EXECUTOR: ReadonlySet<ActionKind> = new Set<ActionKind>([
  "pause_campaign",
  "resume_campaign",
  "reduce_campaign_budget",
  "increase_campaign_budget",
  "reallocate_budget",
  "reallocate_inventory",
  "reallocate_spend_sku",
  "discontinue_sku",
  "adjust_price",
  "create_po_draft",
]);

// Per-action reversibility tier. increase_campaign_budget is hard_to_reverse
// until it gains an undoAction branch (spec I7); physical/free-ship kinds are
// irreversible.
const ACTION_TIER: Partial<Record<ActionKind, Tier>> = {
  pause_campaign: "reversible",
  resume_campaign: "reversible",
  reduce_campaign_budget: "reversible",
  reallocate_budget: "reversible",
  exclude_geo: "reversible",
  snooze_alert: "reversible",
  increase_campaign_budget: "hard_to_reverse",
  create_po_draft: "hard_to_reverse",
  // Reversible via its undo branch (re-publish + clear flag, 48h auto-undo) but
  // archiving a product is more consequential than a budget tweak.
  discontinue_sku: "hard_to_reverse",
  // Customer-visible but reversible via its undo branch (re-set the prior price).
  adjust_price: "hard_to_reverse",
  reallocate_inventory: "irreversible",
  exclude_sku_free_ship: "irreversible",
  raise_free_ship_threshold: "irreversible",
};

// Pairs that ship unlocked. They still require shop-level Autopilot, per-feature
// enablement, guardrails, freshness, undo support, and live preconditions.
// Keys are "<detector>:<action>". A test asserts each is a legal pair.
export const NO_BRAINER: ReadonlySet<string> = new Set<string>([
  "sku_stockout_vs_spend:pause_campaign",
  "campaign_below_breakeven:pause_campaign",
  "negative_unit_economics:pause_campaign",
]);

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);
const clampInt = (n: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, Math.round(n)));

export function actionTier(action: ActionKind): Tier {
  return ACTION_TIER[action] ?? "irreversible";
}

export function reversibilityFactor(tier: Tier): number {
  return REVERSIBILITY_FACTOR[tier];
}

export function pairPrior(tier: Tier, isNoBrainer: boolean, peerP50: number | null): number {
  if (peerP50 != null && peerP50 > 0) return Math.min(PRIOR_CLAMP_MAX, clamp01(peerP50));
  const base = REVERSIBILITY_BASE[tier];
  const p = isNoBrainer ? base * NOBRAINER_BONUS : base;
  return Math.min(PRIOR_CLAMP_MAX, clamp01(p));
}

export function historical(alpha: number, beta: number, pPrior: number, k = K_PRIOR): number {
  const a0 = k * pPrior;
  const b0 = k * (1 - pPrior);
  const denom = alpha + beta + a0 + b0;
  if (!(denom > 0)) return clamp01(pPrior);
  return clamp01((alpha + a0) / denom);
}

export function confidence(i: {
  guardrailVeto: 0 | 1;
  detection: number;
  historical: number;
  reversibility: number;
}): number {
  if (i.guardrailVeto === 0) return 0;
  const blended =
    WEIGHTS.detection * clamp01(i.detection) +
    WEIGHTS.historical * clamp01(i.historical) +
    WEIGHTS.reversibility * clamp01(i.reversibility);
  const c = Math.round(100 * blended);
  return Number.isFinite(c) ? clampInt(c, 0, 100) : 0;
}

// Cold-start detection factor (capped until per-detector precision history exists).
export const DETECTION_COLD = 0.6;

// Convenience: full per-(detector, action) confidence from the pair's Beta
// counters + optional peer prior. The single entry point used by both the
// nightly recompute and the Action Queue, so the two never diverge.
export function pairConfidence(
  detectorId: string,
  actionKind: ActionKind,
  ev: { alpha: number; beta: number },
  peerP50: number | null,
): number {
  const pairKey = `${detectorId}:${actionKind}`;
  const isNoBrainer = NO_BRAINER.has(pairKey);
  const tier = actionTier(actionKind);
  const veto: 0 | 1 = HAS_EXECUTOR.has(actionKind) ? 1 : 0;
  const prior = pairPrior(tier, isNoBrainer, peerP50);
  const hist = historical(ev.alpha, ev.beta, prior);
  const raw = confidence({
    guardrailVeto: veto,
    detection: DETECTION_COLD,
    historical: hist,
    reversibility: reversibilityFactor(tier),
  });
  // I8: No-brainer pairs get a confidence floor so reject-spam can never drive
  // them to conf=0 (permanent self-disable). The floor ONLY applies to NO_BRAINER
  // pairs — normal pairs can reach 0 (correct behavior for probation/mute paths).
  // This keeps no-brainers surfacing as "always ask" even after heavy rejects.
  if (isNoBrainer && raw < NO_BRAINER_CONF_FLOOR) return NO_BRAINER_CONF_FLOOR;
  return raw;
}

export function calibrationPct(pairs: { conf: number; weight: number }[]): number {
  let totalWeight = 0;
  let acc = 0;
  for (const p of pairs) {
    const w = Number.isFinite(p.weight) && p.weight > 0 ? p.weight : 0;
    const c = Number.isFinite(p.conf) ? p.conf : 0;
    totalWeight += w;
    acc += w * c;
  }
  if (!(totalWeight > 0)) return 0;
  return clampInt(acc / totalWeight, 0, 100);
}

export function smooth(
  raw: number,
  prevDisplay: number | null,
  opts?: { maxStep?: number; deadBand?: number },
): number {
  const maxStep = opts?.maxStep ?? 5;
  const deadBand = opts?.deadBand ?? 1;
  if (prevDisplay == null) return clampInt(raw, 0, 100);
  const ewma = 0.3 * raw + 0.7 * prevDisplay;
  let next = Math.round(ewma);
  const delta = next - prevDisplay;
  if (Math.abs(delta) < deadBand) return prevDisplay;
  if (delta > maxStep) next = prevDisplay + maxStep;
  else if (delta < -maxStep) next = prevDisplay - maxStep;
  return clampInt(next, 0, 100);
}

/* ---------- confidence breakdown (Live Engine pipeline + inspector) ---------- */

export interface ConfidenceFactor {
  key: "detection" | "historical" | "reversibility";
  /** Plain-language merchant-facing label. */
  label: string;
  /** Raw factor strength, 0-100. */
  value: number;
  /** Share of the blended confidence, 0-1. */
  weight: number;
}

export interface ConfidenceBreakdown {
  factors: ConfidenceFactor[];
  /** Final blended confidence (identical to pairConfidence for the same inputs). */
  confidence: number;
}

const FACTOR_LABELS: Record<ConfidenceFactor["key"], string> = {
  detection: "Signal strength",
  historical: "Your track record",
  reversibility: "How easily undone",
};

/**
 * Decompose a pair's confidence into its three weighted factors, for the
 * "how it weighed this" pipeline + inspector on the Live Engine. Pure: same
 * inputs/formula as pairConfidence, just surfaced per-factor.
 */
export function pairConfidenceBreakdown(
  detectorId: string,
  actionKind: ActionKind,
  ev: { alpha: number; beta: number },
  peerP50: number | null,
): ConfidenceBreakdown {
  const tier = actionTier(actionKind);
  const isNoBrainer = NO_BRAINER.has(`${detectorId}:${actionKind}`);
  const prior = pairPrior(tier, isNoBrainer, peerP50);
  const hist = historical(ev.alpha, ev.beta, prior);
  const rev = reversibilityFactor(tier);
  return {
    factors: [
      { key: "detection", label: FACTOR_LABELS.detection, value: Math.round(DETECTION_COLD * 100), weight: WEIGHTS.detection },
      { key: "historical", label: FACTOR_LABELS.historical, value: Math.round(clamp01(hist) * 100), weight: WEIGHTS.historical },
      { key: "reversibility", label: FACTOR_LABELS.reversibility, value: Math.round(rev * 100), weight: WEIGHTS.reversibility },
    ],
    confidence: pairConfidence(detectorId, actionKind, ev, peerP50),
  };
}
