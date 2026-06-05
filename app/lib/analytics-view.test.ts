import { describe, it, expect } from "vitest";
import {
  formatRoas,
  gradeTone,
  toRoasSeries,
  type DailyRoasRow,
} from "./analytics-view";

describe("toRoasSeries", () => {
  it("maps day/roas rows to MarginChart MarginPoint shape", () => {
    const rows: DailyRoasRow[] = [
      { day: "2026-05-01", spend_cents: 10000, revenue_cents: 25000 },
      { day: "2026-05-02", spend_cents: 0, revenue_cents: 0 },
    ];
    expect(toRoasSeries(rows)).toEqual([
      { date: "2026-05-01", margin_pct: 2.5 },
      { date: "2026-05-02", margin_pct: 0 },
    ]);
  });
});

describe("formatRoas", () => {
  it("renders a 2-dp x-suffixed ratio", () => {
    expect(formatRoas(2.5)).toBe("2.50x");
    expect(formatRoas(0)).toBe("0.00x");
  });
});

describe("gradeTone", () => {
  it("maps grade -> Polaris Badge tone", () => {
    expect(gradeTone("winning")).toBe("success");
    expect(gradeTone("okay")).toBe("warning");
    expect(gradeTone("poor")).toBe("critical");
    expect(gradeTone("unknown")).toBeUndefined();
  });
});
