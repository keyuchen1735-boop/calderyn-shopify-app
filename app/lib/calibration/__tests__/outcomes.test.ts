import { describe, it, expect } from "vitest";
import { tallyOutcomes } from "../outcomes";

describe("tallyOutcomes", () => {
  it("nets positives minus negatives, floored at zero", () => {
    const t = tallyOutcomes([
      { signal: 12, closedAt: "2026-06-20T00:00:00Z" },
      { signal: 8, closedAt: "2026-06-21T00:00:00Z" },
      { signal: -100, closedAt: "2026-06-22T00:00:00Z" },
    ]);
    expect(t.netPositive).toBe(1); // 2 positive - 1 negative
  });

  it("floors net at zero when negatives dominate", () => {
    const t = tallyOutcomes([
      { signal: -5, closedAt: "2026-06-20T00:00:00Z" },
      { signal: -5, closedAt: "2026-06-21T00:00:00Z" },
      { signal: 3, closedAt: "2026-06-19T00:00:00Z" },
    ]);
    expect(t.netPositive).toBe(0);
  });

  it("reports the sign of the most recently closed outcome", () => {
    const t = tallyOutcomes([
      { signal: 50, closedAt: "2026-06-25T00:00:00Z" },
      { signal: -1, closedAt: "2026-06-26T00:00:00Z" }, // latest
    ]);
    expect(t.lastSign).toBe(-1);
  });

  it("treats zero reward as neither positive nor negative", () => {
    const t = tallyOutcomes([{ signal: 0, closedAt: "2026-06-26T00:00:00Z" }]);
    expect(t.netPositive).toBe(0);
    expect(t.lastSign).toBe(0);
  });

  it("returns an empty tally for no rows", () => {
    expect(tallyOutcomes([])).toEqual({ netPositive: 0, lastSign: 0 });
  });
});
