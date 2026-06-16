import { describe, it, expect } from "vitest";
import { stateDiff } from "../audit-state-diff";

describe("stateDiff", () => {
  it("reallocate_budget → source + dest daily budgets as before→after (the headline case)", () => {
    const rows = stateDiff(
      "reallocate_budget",
      { dest: { daily_budget_cents: 700 }, source: { daily_budget_cents: 800 } },
      { dest: { daily_budget_cents: 500 }, source: { daily_budget_cents: 1000 } },
    );
    expect(rows).toEqual([
      { label: "Source daily budget", before: "$8.00", after: "$10.00" },
      { label: "Dest daily budget", before: "$7.00", after: "$5.00" },
    ]);
  });

  it("reduce_campaign_budget with unchanged status → only the budget row", () => {
    const rows = stateDiff(
      "reduce_campaign_budget",
      { status: "paused", daily_budget_cents: 1000 },
      { status: "paused", daily_budget_cents: 900 },
    );
    expect(rows).toEqual([{ label: "Daily budget", before: "$10.00", after: "$9.00" }]);
  });

  it("pause_campaign → status change", () => {
    const rows = stateDiff(
      "pause_campaign",
      { status: "active", daily_budget_cents: 5000 },
      { status: "paused", daily_budget_cents: 5000 },
    );
    expect(rows).toEqual([{ label: "Status", before: "active", after: "paused" }]);
  });

  it("create_po_draft → after-only PO total + quantity (no 'before')", () => {
    const rows = stateDiff("create_po_draft", null, {
      po: { total_cents: 115900, lines: [{ quantity: 122, unit_cost_cents: 950 }] },
    });
    expect(rows).toEqual([
      { label: "PO total", before: null, after: "$1,159.00" },
      { label: "Quantity", before: null, after: "122 units" },
    ]);
  });

  it("reallocate_inventory with failed post (null) → no row rather than raw JSON", () => {
    expect(stateDiff("reallocate_inventory", { from_location_available: 10 }, null)).toEqual([]);
  });

  it("unknown/empty shapes → [] (never raw JSON)", () => {
    expect(stateDiff("snooze_alert", { foo: 1 }, { bar: 2 })).toEqual([]);
    expect(stateDiff("reallocate_budget", null, null)).toEqual([]);
  });
});
