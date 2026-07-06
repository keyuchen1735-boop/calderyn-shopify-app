// app/lib/sourcing/score.test.ts
import { describe, it, expect } from "vitest";
import { scoreVirality, resolveScoringPhase, type ScoreInputs } from "./score";

const base: ScoreInputs = {
  orderVolume30d: 8000,
  orderVolume7d: 3000,
  trendIndex: 85,
  firstSeenDaysAgo: 3,
  unitCostCents: 800,
  suggestedRetailCents: 2400,
  leadTimeDays: 9,
};

describe("scoreVirality", () => {
  it("scores a fresh, accelerating, high-margin product high", () => {
    expect(scoreVirality(base).score).toBeGreaterThan(70);
  });

  it("is deterministic", () => {
    expect(scoreVirality(base)).toEqual(scoreVirality(base));
  });

  it("decays a peaked (old) product toward zero regardless of volume", () => {
    const stale = scoreVirality({ ...base, firstSeenDaysAgo: 120 });
    expect(stale.decay).toBeLessThan(0.1);
    expect(stale.score).toBeLessThan(15);
  });

  it("penalizes thin margin vs a fat-margin twin", () => {
    const thin = scoreVirality({ ...base, suggestedRetailCents: 900 }); // ~11% margin
    const fat = scoreVirality(base); // ~67% margin
    expect(thin.score).toBeLessThan(fat.score);
  });

  it("clamps to 0..100", () => {
    const huge = scoreVirality({ ...base, orderVolume30d: 1e9, trendIndex: 100 });
    expect(huge.score).toBeLessThanOrEqual(100);
    expect(
      scoreVirality({ ...base, orderVolume30d: 0, orderVolume7d: 0, trendIndex: 0 }).score,
    ).toBeGreaterThanOrEqual(0);
  });
});

describe("resolveScoringPhase", () => {
  it("stays external below 2000 users", () => {
    expect(resolveScoringPhase(0)).toBe("external");
    expect(resolveScoringPhase(1999)).toBe("external");
  });
  it("flips to blended at 2000 users (the founder-set gate)", () => {
    expect(resolveScoringPhase(2000)).toBe("blended");
  });
});
