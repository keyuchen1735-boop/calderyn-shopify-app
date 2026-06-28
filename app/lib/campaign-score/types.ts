// The Calderyn score DTO + its tunable constants. Pure types/values — safe to
// import on the server (aggregate/blend/resolve) and in browser type positions
// (CampaignVM, the Campaign DTO). No I/O, no .server dependency.

export interface CampaignCalderynScore {
  value: number | null; // blended 0–100, null when band === "nodata"
  band: "strong" | "fair" | "weak" | "nodata";
  performance: number | null; // P
  creative: number | null; // C
  confidence: "high" | "medium" | "low";
  weakDimensions: { label: string; score: number; adId: string }[];
  tips: string[];
  adsCovered: number;
  adsTotal: number;
}

// Blend weighting — performance-led (locked design decision §2.6).
export const PERF_WEIGHT = 0.7;
export const CREATIVE_WEIGHT = 0.3;

// Band thresholds on the blended 0–100 value.
export const STRONG_MIN = 75; // value >= STRONG_MIN => "strong"
export const FAIR_MIN = 55; // value >= FAIR_MIN => "fair", else "weak"

// Performance normalization: break-even ROAS anchors at 50; a 2× return
// saturates at 100. P = clamp(round(PERF_ANCHOR * roas / breakEven), 0, 100).
export const PERF_ANCHOR = 50;
