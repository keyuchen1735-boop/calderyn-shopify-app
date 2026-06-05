// app/lib/simulator/__tests__/runs.test.ts
import { describe, it, expect } from "vitest";
import { rowToRun } from "../runs.server";

describe("rowToRun", () => {
  it("maps a DB row to a SimulationRun DTO", () => {
    const dto = rowToRun({
      id: "run-1",
      status: "done",
      target: "whole_store",
      requested_n: 1000,
      model: { storeSummary: "s", shipping: { amount: 9.95, currency: "USD", estimated: false }, archetypes: [], findings: [] },
      error: null,
      created_at: "2026-06-04T00:00:00Z",
      completed_at: "2026-06-04T00:00:30Z",
    });
    expect(dto).toEqual({
      id: "run-1",
      status: "done",
      target: "whole_store",
      requestedN: 1000,
      model: { storeSummary: "s", shipping: { amount: 9.95, currency: "USD", estimated: false }, archetypes: [], findings: [] },
      error: null,
      createdAt: "2026-06-04T00:00:00Z",
      completedAt: "2026-06-04T00:00:30Z",
    });
  });

  it("defaults missing model/error/completed_at to null", () => {
    const dto = rowToRun({ id: "r", status: "queued", target: "whole_store", requested_n: 10, created_at: "t" });
    expect(dto.model).toBeNull();
    expect(dto.error).toBeNull();
    expect(dto.completedAt).toBeNull();
  });
});
