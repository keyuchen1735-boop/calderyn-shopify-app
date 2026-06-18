import { describe, it, expect } from "vitest";
import { gradeFromRow, gradeLabel } from "../campaign-grade";

// P1-6: the grading engine emits "poor" with revenue_cents:0 for campaigns that
// actually have real return — an attribution gap, not below-break-even. The
// display must call that "no data", never "poor".
describe("gradeFromRow", () => {
  it("returns 'nodata' when there is spend but zero attributed revenue", () => {
    expect(
      gradeFromRow({ grade: "poor", roas: 0, break_even_roas: 2.5, spend_cents: 3187, revenue_cents: 0 }),
    ).toBe("nodata");
  });

  it("keeps a real engine grade when revenue is present", () => {
    expect(
      gradeFromRow({ grade: "winning", roas: 5.8, break_even_roas: 1.6, spend_cents: 11411, revenue_cents: 67186 }),
    ).toBe("winning");
  });

  it("derives from roas vs break-even when the engine grade is missing/invalid", () => {
    expect(gradeFromRow({ roas: 4, break_even_roas: 2, spend_cents: 100, revenue_cents: 400 })).toBe("winning");
    expect(gradeFromRow({ roas: 2.1, break_even_roas: 2, spend_cents: 100, revenue_cents: 210 })).toBe("okay");
    expect(gradeFromRow({ roas: 1, break_even_roas: 2, spend_cents: 100, revenue_cents: 100 })).toBe("poor");
  });

  it("does not flag 'nodata' when there is no spend either (nothing to grade → okay default)", () => {
    expect(gradeFromRow({ spend_cents: 0, revenue_cents: 0 })).toBe("okay");
  });

  it("labels nodata as 'No data'", () => {
    expect(gradeLabel("nodata")).toMatch(/no data/i);
    expect(gradeLabel("poor")).toBe("Poor");
  });
});
