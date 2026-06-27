// app/lib/campaign-score/blend.server.ts
// PURE (no I/O): blend the performance half (P) and creative half (C) into the
// CampaignCalderynScore. All score arithmetic lives here (rule 5 — deterministic
// code does the math, the model does none). weakDimensions/tips are filled by
// resolve from the aggregate; blend starts them empty.
import type { CampaignCalderynScore } from "./types";
import { PERF_WEIGHT, CREATIVE_WEIGHT, STRONG_MIN, FAIR_MIN } from "./types";

export function blendScore(input: {
  performance: number | null;
  creative: number | null;
  coverage: { covered: number; total: number };
  perfIsNodata: boolean;
}): CampaignCalderynScore {
  const { performance, creative, coverage, perfIsNodata } = input;

  let value: number | null;
  if (performance != null && creative != null) {
    value = Math.round(PERF_WEIGHT * performance + CREATIVE_WEIGHT * creative);
  } else if (performance != null) {
    value = Math.round(performance);
  } else if (creative != null) {
    value = Math.round(creative);
  } else {
    value = null;
  }

  return {
    value,
    band: bandFor(value),
    performance,
    creative,
    confidence: confidenceFor(performance, creative, coverage, perfIsNodata),
    weakDimensions: [],
    tips: [],
    adsCovered: coverage.covered,
    adsTotal: coverage.total,
  };
}

function bandFor(value: number | null): CampaignCalderynScore["band"] {
  if (value == null) return "nodata";
  if (value >= STRONG_MIN) return "strong";
  if (value >= FAIR_MIN) return "fair";
  return "weak";
}

// Confidence is driven by ad coverage and whether each half is real. A missing
// or nodata half is never treated as "real", so it caps confidence (spec §3:
// "a low-confidence banner shows when coverage is thin or a half is missing").
function confidenceFor(
  performance: number | null,
  creative: number | null,
  coverage: { covered: number; total: number },
  perfIsNodata: boolean,
): CampaignCalderynScore["confidence"] {
  const ratio = coverage.total > 0 ? coverage.covered / coverage.total : 0;
  const perfReal = performance != null && !perfIsNodata;
  const creativeReal = creative != null;
  if (perfReal && creativeReal && ratio >= 0.8) return "high";
  if ((perfReal || creativeReal) && ratio >= 0.4) return "medium";
  return "low";
}
