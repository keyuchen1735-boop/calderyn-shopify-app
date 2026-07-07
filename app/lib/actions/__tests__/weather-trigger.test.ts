import { describe, it, expect } from "vitest";
import { evaluateArmed, SCORE_GAP_FLOOR } from "../weather-suggest.server";
import type { RegionCode } from "../../ads/actions";

const row = (over: Partial<{ source_region: string; dest_region: string; expires_on: string }> = {}) => ({
  source_region: "us-west",
  dest_region: "us-east",
  expires_on: "2026-07-09",
  ...over,
});

const scores = (src: number, dst: number) =>
  new Map<RegionCode, number>([
    ["us-west", src],
    ["us-east", dst],
  ]);

describe("evaluateArmed", () => {
  it("executes when the fresh forecast still shows the score gap", () => {
    expect(evaluateArmed(row(), scores(0.2, 0.2 + SCORE_GAP_FLOOR + 0.05), "2026-07-07")).toBe("execute");
  });

  it("holds when the gap has closed but the window is still open", () => {
    expect(evaluateArmed(row(), scores(0.3, 0.35), "2026-07-07")).toBe("hold");
  });

  it("expires when today is past expires_on, even if the gap holds", () => {
    expect(evaluateArmed(row(), scores(0.1, 0.9), "2026-07-10")).toBe("expire");
  });

  it("still executes on the expiry day itself", () => {
    expect(evaluateArmed(row(), scores(0.1, 0.9), "2026-07-09")).toBe("execute");
  });

  it("holds when either region's fresh score is missing (no fabricated trigger)", () => {
    const partial = new Map<RegionCode, number>([["us-west", 0.1]]);
    expect(evaluateArmed(row(), partial, "2026-07-07")).toBe("hold");
  });
});
