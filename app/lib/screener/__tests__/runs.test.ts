import { describe, it, expect } from "vitest";
import { rowToRun } from "../runs.server";

describe("rowToRun", () => {
  it("shapes a DB row into the DTO, never leaking shop_id", () => {
    const dto = rowToRun({
      id: "run-1",
      status: "done",
      source: "manual",
      meta_ad_id: null,
      assumed_spend_cents: 50000,
      scorecard: { composite: 64, grade: "okay" },
      error: null,
      created_at: "2026-06-07T00:00:00Z",
      completed_at: "2026-06-07T00:00:05Z",
      shop_id: "secret",
    });
    expect(dto.id).toBe("run-1");
    expect(dto.assumedSpendCents).toBe(50000);
    expect(dto.scorecard).toEqual({ composite: 64, grade: "okay" });
    expect((dto as unknown as Record<string, unknown>).shop_id).toBeUndefined();
  });

  it("defaults missing optionals", () => {
    const dto = rowToRun({ id: "r", status: "running", created_at: "t" });
    expect(dto.source).toBe("manual");
    expect(dto.scorecard).toBeNull();
    expect(dto.completedAt).toBeNull();
  });
});
