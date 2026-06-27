import { describe, it, expect } from "vitest";
import { scorePillStyle } from "../score-pill";
import type { CampaignCalderynScore } from "~/lib/campaign-score/types";

const s = (over: Partial<CampaignCalderynScore>): CampaignCalderynScore => ({
  value: 70, band: "fair", performance: 70, creative: 70, confidence: "high",
  weakDimensions: [], tips: [], adsCovered: 1, adsTotal: 1, ...over,
});

describe("scorePillStyle", () => {
  it("maps each scored band to its tone and shows 'value · Band'", () => {
    expect(scorePillStyle(s({ value: 82, band: "strong" }))).toEqual({ label: "82 · Strong", tone: "success" });
    expect(scorePillStyle(s({ value: 60, band: "fair" }))).toEqual({ label: "60 · Fair", tone: "warn" });
    expect(scorePillStyle(s({ value: 40, band: "weak" }))).toEqual({ label: "40 · Weak", tone: "critical" });
  });

  it("shows 'Score pending' with a neutral tone when value is null (nodata)", () => {
    expect(scorePillStyle(s({ value: null, band: "nodata" }))).toEqual({ label: "Score pending", tone: "neutral" });
  });
});
