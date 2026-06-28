import { describe, it, expect } from "vitest";
import {
  PERF_WEIGHT,
  CREATIVE_WEIGHT,
  STRONG_MIN,
  FAIR_MIN,
  PERF_ANCHOR,
} from "../types";

describe("campaign-score constants", () => {
  it("locks the blend weighting, band thresholds, and perf anchor", () => {
    expect(PERF_WEIGHT).toBe(0.7);
    expect(CREATIVE_WEIGHT).toBe(0.3);
    expect(PERF_WEIGHT + CREATIVE_WEIGHT).toBe(1);
    expect(STRONG_MIN).toBe(75);
    expect(FAIR_MIN).toBe(55);
    expect(PERF_ANCHOR).toBe(50);
  });
});
