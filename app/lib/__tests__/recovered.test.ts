import { describe, expect, test } from "vitest";
import { dailyActionBudgetUsedCents, recovered } from "../recovered";

const entry = (
  outcome: string,
  dollar_impact_at_exec: number,
  undo_of?: string | null,
  id?: string,
) => ({ id, outcome, dollar_impact_at_exec, undo_of });

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

  test("pulls back the original action's impact once it has been undone", () => {
    const result = recovered([
      entry("succeeded", 12_000, null, "au-1"), // the original
      entry("succeeded", -12_000, "au-1", "au-2"), // its undo
      entry("succeeded", 8_000, null, "au-3"), // an unrelated, still-standing action
    ]);
    // au-1 is undone → excluded; au-2 is an undo row → excluded; only au-3 counts.
    expect(result).toEqual({ cents: 8_000, count: 1 });
  });

  test("pull-back is robust even when the undo row records no negative impact", () => {
    const result = recovered([
      entry("succeeded", 12_000, null, "au-1"),
      entry("succeeded", 0, "au-1", "au-2"), // undo row with impact omitted/zero
    ]);
    expect(result).toEqual({ cents: 0, count: 0 });
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

describe("dailyActionBudgetUsedCents — what you acted on today", () => {
  const START = "2026-06-10T00:00:00.000Z";
  const todayRow = (
    outcome: string,
    cents: number,
    created_at: string,
    undo_of?: string | null,
  ) => ({ outcome, dollar_impact_at_exec: cents, created_at, undo_of });

  test("counts a $4669 pause acted on today against the budget", () => {
    const used = dailyActionBudgetUsedCents(
      [todayRow("succeeded", 466_900, "2026-06-10T14:30:00.000Z")],
      START,
    );
    expect(used).toBe(466_900);
  });

  test("excludes actions from previous days", () => {
    const used = dailyActionBudgetUsedCents(
      [
        todayRow("succeeded", 466_900, "2026-06-10T14:30:00.000Z"),
        todayRow("succeeded", 10_000, "2026-06-09T23:59:00.000Z"),
      ],
      START,
    );
    expect(used).toBe(466_900);
  });

  test("counts a row in the first microsecond of the day (Postgres +00:00 format)", () => {
    // PostgREST returns created_at with microseconds and a +00:00 offset, while
    // the cutoff is the millisecond 'Z' form — a byte-wise compare would drop this.
    const used = dailyActionBudgetUsedCents(
      [todayRow("succeeded", 466_900, "2026-06-10T00:00:00.000001+00:00")],
      START,
    );
    expect(used).toBe(466_900);
  });

  test("ignores failed actions and undo rows", () => {
    const used = dailyActionBudgetUsedCents(
      [
        todayRow("succeeded", 466_900, "2026-06-10T14:30:00.000Z"),
        todayRow("failed", 99_000, "2026-06-10T15:00:00.000Z"),
        todayRow("succeeded", 466_900, "2026-06-10T16:00:00.000Z", "au-1"),
      ],
      START,
    );
    expect(used).toBe(466_900);
  });

  test("claws back an undone action when rows carry ids (live query shape)", () => {
    // Regression: dailyUsedCents selected rows WITHOUT id, so recovered()'s
    // undone-set could never match and the meter kept counting undone actions.
    const used = dailyActionBudgetUsedCents(
      [
        {
          id: "au-1",
          outcome: "succeeded",
          dollar_impact_at_exec: 466_900,
          created_at: "2026-06-10T14:30:00.000Z",
          undo_of: null,
        },
        {
          id: "au-2",
          outcome: "succeeded",
          dollar_impact_at_exec: -466_900,
          created_at: "2026-06-10T15:00:00.000Z",
          undo_of: "au-1",
        },
      ],
      START,
    );
    expect(used).toBe(0);
  });
});
