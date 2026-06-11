import { describe, it, expect } from "vitest";
import { recoveredCentsForAction, recoveredCentsFromStates } from "../audit-impact";

describe("recoveredCentsForAction", () => {
  it("recovers the full at-stake amount for a created PO draft", () => {
    expect(recoveredCentsForAction("create_po_draft", 341250)).toBe(341250);
  });

  it("recovers the at-stake amount when a losing campaign is paused", () => {
    expect(recoveredCentsForAction("pause_campaign", 169303)).toBe(169303);
  });

  it("recovers the at-stake amount for a budget reduction or reallocation", () => {
    expect(recoveredCentsForAction("reduce_campaign_budget", 169303)).toBe(169303);
    expect(recoveredCentsForAction("reallocate_budget", 169303)).toBe(169303);
    expect(recoveredCentsForAction("reallocate_inventory", 406600)).toBe(406600);
    expect(recoveredCentsForAction("exclude_geo", 625)).toBe(625);
  });

  it("recovers nothing for neutral actions (snooze, resume)", () => {
    // Snoozing or resuming defers/undoes — no money is recovered.
    expect(recoveredCentsForAction("snooze_alert", 79748)).toBe(0);
    expect(recoveredCentsForAction("resume_campaign", 169303)).toBe(0);
  });

  it("never returns a negative or fractional cent value", () => {
    expect(recoveredCentsForAction("pause_campaign", -500)).toBe(0);
    expect(recoveredCentsForAction("create_po_draft", 100.7)).toBe(101);
  });
});

describe("recoveredCentsFromStates (no-alert fallback)", () => {
  it("pause_campaign recovers the daily budget being stopped", () => {
    expect(
      recoveredCentsFromStates(
        "pause_campaign",
        { status: "active", daily_budget_cents: 5000 },
        { status: "paused", daily_budget_cents: 5000 },
      ),
    ).toBe(5000);
  });

  it("reduce_campaign_budget recovers the daily delta, never a negative for an increase", () => {
    expect(
      recoveredCentsFromStates(
        "reduce_campaign_budget",
        { status: "active", daily_budget_cents: 5000 },
        { status: "active", daily_budget_cents: 3500 },
      ),
    ).toBe(1500);
    // A budget INCREASE recovers nothing.
    expect(
      recoveredCentsFromStates(
        "reduce_campaign_budget",
        { status: "active", daily_budget_cents: 5000 },
        { status: "active", daily_budget_cents: 9000 },
      ),
    ).toBe(0);
  });

  it("reallocate_budget recovers the daily amount moved off the source", () => {
    expect(
      recoveredCentsFromStates(
        "reallocate_budget",
        { source: { daily_budget_cents: 2000 }, dest: { daily_budget_cents: 1000 } },
        { source: { daily_budget_cents: 1500 }, dest: { daily_budget_cents: 1500 } },
      ),
    ).toBe(500);
  });

  it("recovers nothing for neutral kinds and survives malformed states", () => {
    expect(
      recoveredCentsFromStates(
        "resume_campaign",
        { status: "paused", daily_budget_cents: 5000 },
        { status: "active", daily_budget_cents: 5000 },
      ),
    ).toBe(0);
    expect(recoveredCentsFromStates("pause_campaign", null, null)).toBe(0);
    expect(
      recoveredCentsFromStates("pause_campaign", { daily_budget_cents: "garbage" }, null),
    ).toBe(0);
    expect(recoveredCentsFromStates("reallocate_budget", {}, {})).toBe(0);
  });
});
