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
  reallocate_inventory: "irreversible",
  exclude_sku_free_ship: "irreversible",
  raise_free_ship_threshold: "irreversible",
};

// Pairs that ship pre-trusted (still shadow-gated before any autonomy in later
// slices). Keys are "<detector>:<action>". A test asserts each is a legal pair.
export const NO_BRAINER: ReadonlySet<string> = new Set<string>([
  "sku_stockout_vs_spend:pause_campaign",
  "campaign_below_breakeven:pause_campaign",
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
