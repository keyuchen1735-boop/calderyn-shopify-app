// app/lib/screener/calibrate.server.ts
// Pure deterministic calibration. No I/O, no model calls. The model judges
// (dimension scores); this code does the arithmetic that turns those judgments
// + the merchant's real history into predicted outcomes.
import {
  DEFAULT_AOV_CENTS, DEFAULT_CVR,
  type CalibrationInputs, type Confidence, type Grade,
  type MetricScore, type PredictedOutcomes,
} from "./types";

const byId = (metrics: MetricScore[], id: string): number =>
  metrics.find((m) => m.id === id)?.score ?? 50;

const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);

// Dimensions that drive click-through, with weights. Average score 50 ⇒ 1.0×.
const CTR_WEIGHTS: Record<string, number> = {
  hook_strength: 0.35,
  visual_focal_clarity: 0.2,
  cta_strength: 0.2,
  offer_strength: 0.15,
  creative_offer_fit: 0.1,
};

export function ctrMultiplier(metrics: MetricScore[]): number {
  let weighted = 0;
  let total = 0;
  for (const [id, w] of Object.entries(CTR_WEIGHTS)) {
    weighted += byId(metrics, id) * w;
    total += w;
  }
  const avg = total > 0 ? weighted / total : 50;
  return clamp(avg / 50, 0.3, 2.5);
}

// Hold/engagement driven by attention group.
function engagementMultiplier(metrics: MetricScore[]): number {
  const ids = ["hook_strength", "visual_focal_clarity", "brand_presence"];
  const avg = ids.reduce((s, id) => s + byId(metrics, id), 0) / ids.length;
  return clamp(avg / 50, 0.3, 2.5);
}

export function compositeScore(metrics: MetricScore[]): number {
  if (metrics.length === 0) return 0;
  const avg = metrics.reduce((s, m) => s + m.score, 0) / metrics.length;
  return Math.round(clamp(avg, 0, 100));
}

export function gradeFor(composite: number): Grade {
  if (composite >= 75) return "winning";
  if (composite >= 55) return "okay";
  return "poor";
}

function confidenceFor(inputs: CalibrationInputs): Confidence {
  if (inputs.historyAdCount >= 15 && inputs.skuPriceCents != null && inputs.skuCvr != null) {
    return "high";
  }
  // A resolved real SKU price grounds the estimate enough for medium, even before
  // Plan 2 wires a real ad-count / CVR. Without either signal we stay honest at low.
  if (inputs.historyAdCount >= 5 || inputs.skuPriceCents != null) return "medium";
  return "low";
}

// Band half-width as a fraction of the point estimate, by confidence.
const BAND: Record<Confidence, { lo: number; hi: number }> = {
  high: { lo: 0.25, hi: 0.3 },
  medium: { lo: 0.4, hi: 0.5 },
  low: { lo: 0.6, hi: 0.8 },
};

export function calibrate(
  metrics: MetricScore[],
  inputs: CalibrationInputs,
  assumedSpendCents: number,
): { outcomes: PredictedOutcomes; composite: number; grade: Grade; confidence: Confidence } {
  const confidence = confidenceFor(inputs);

  const predictedCtr = clamp(inputs.accountBaselineCtr * ctrMultiplier(metrics), 0, 1);
  const holdRate = clamp(inputs.accountEngagementRate * engagementMultiplier(metrics), 0, 1);

  const cpm = inputs.accountBaselineCpmCents || 1;
  const projectedImpressions = (assumedSpendCents / cpm) * 1000;
  const predictedClicks = projectedImpressions * predictedCtr;

  const cvr = inputs.skuCvr ?? DEFAULT_CVR;
  const priceCents = inputs.skuPriceCents ?? DEFAULT_AOV_CENTS;
  const predictedOrders = predictedClicks * cvr;
  const predictedRevenueCents = predictedOrders * priceCents;

  const estimatedRoas = assumedSpendCents > 0
    ? predictedRevenueCents / assumedSpendCents
    : 0;

  const band = BAND[confidence];
  const outcomes: PredictedOutcomes = {
    estimatedRoas: Number(estimatedRoas.toFixed(2)),
    roasLow: Number((estimatedRoas * (1 - band.lo)).toFixed(2)),
    roasHigh: Number((estimatedRoas * (1 + band.hi)).toFixed(2)),
    breakEvenRoas: inputs.breakEvenRoas,
    predictedCtr,
    holdRate,
    assumedSpendCents,
    predictedRevenueCents: Math.round(predictedRevenueCents),
    mappedSku: inputs.mappedSku,
    skuPriceCents: inputs.skuPriceCents,
  };

  const composite = compositeScore(metrics);
  return { outcomes, composite, grade: gradeFor(composite), confidence };
}
