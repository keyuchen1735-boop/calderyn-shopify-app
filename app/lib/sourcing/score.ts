// app/lib/sourcing/score.ts
// Deterministic virality score (rule 5: ranking is code, never a model call).
// Phase 1 = external signals only. The own-data reweight (Phase 2) is gated on
// >=2000 users and is a SEPARATE future task — resolveScoringPhase only flips
// the label here; scoreVirality is Phase-1 math.

export const OWN_DATA_USER_THRESHOLD = 2000;
export type ScoringPhase = "external" | "blended";

export interface ScoreInputs {
  orderVolume30d: number;
  orderVolume7d: number;
  trendIndex: number; // 0..100 (external, e.g. Google Trends)
  firstSeenDaysAgo: number; // for saturation/decay
  unitCostCents: number;
  suggestedRetailCents: number;
  leadTimeDays: number;
}

export interface ScoreResult {
  score: number; // 0..100
  velocity: number; // 0..1
  momentum: number; // 0..1
  decay: number; // 0..1
  marginPenalty: number; // 0..1
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** Phase gate: below the threshold we cannot trust own-sales data, so rank on
 *  externals only. At/after it, the blended reweight activates (future task). */
export function resolveScoringPhase(userCount: number): ScoringPhase {
  return userCount >= OWN_DATA_USER_THRESHOLD ? "blended" : "external";
}

export function scoreVirality(x: ScoreInputs): ScoreResult {
  // Velocity: log-scaled recent demand (10k+ orders/30d -> ~1).
  const velocity = clamp01(Math.log10(1 + Math.max(0, x.orderVolume30d)) / 4);

  // Momentum: is the 7d run out-pacing the 30d average? (>1 = accelerating.)
  const expected7d = Math.max(1, x.orderVolume30d) * (7 / 30);
  const momentum = clamp01(Math.max(0, x.orderVolume7d) / expected7d / 2);

  const trend = clamp01(x.trendIndex / 100);

  // Decay: a product first seen long ago has likely saturated. Linear to ~0 at 60d.
  const decay = clamp01(1 - Math.max(0, x.firstSeenDaysAgo) / 60);

  // Margin penalty: healthy dropship margin ~>=50%. Penalize below that.
  const margin =
    x.suggestedRetailCents > 0
      ? (x.suggestedRetailCents - x.unitCostCents) / x.suggestedRetailCents
      : 0;
  const marginPenalty = margin >= 0.5 ? 0 : clamp01((0.5 - margin) / 0.5);

  // Lead-time penalty: >20d shipping hurts (small).
  const leadPenalty = x.leadTimeDays > 20 ? clamp01((x.leadTimeDays - 20) / 40) : 0;

  const demand = 0.45 * velocity + 0.3 * momentum + 0.25 * trend; // 0..1
  const raw = demand * decay * (1 - marginPenalty) * (1 - 0.3 * leadPenalty);
  return { score: Math.round(clamp01(raw) * 100), velocity, momentum, decay, marginPenalty };
}
