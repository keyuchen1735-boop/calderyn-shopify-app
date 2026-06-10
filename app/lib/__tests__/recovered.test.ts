import { describe, expect, test } from "vitest";
import { recovered } from "../recovered";

const entry = (
  outcome: string,
  dollar_impact_at_exec: number,
  undo_of?: string | null,
) => ({ outcome, dollar_impact_at_exec, undo_of });

describe("recovered — succeeded actions excluding undo rows", () => {
  test("sums succeeded actions and counts them", () => {
    const result = recovered([
      entry("succeeded", 12_000),
      entry("succeeded", 8_000),
      entry("failed", 50_000),
      entry("retrying", 9_000),
    ]);
    expect(result).toEqual({ cents: 20_000, count: 2 });
  });

  test("excludes undo rows so reverting an action is not double-counted", () => {
    const result = recovered([
      entry("succeeded", 12_000),
      entry("succeeded", 12_000, "au-1"), // the undo of au-1
    ]);
    expect(result).toEqual({ cents: 12_000, count: 1 });
  });

  test("treats a missing dollar impact as zero", () => {
    const result = recovered([
      entry("succeeded", Number.NaN),
      entry("succeeded", 5_000),
    ]);
    expect(result).toEqual({ cents: 5_000, count: 2 });
  });

  test("returns zeros for an empty log", () => {
    expect(recovered([])).toEqual({ cents: 0, count: 0 });
  });
});
