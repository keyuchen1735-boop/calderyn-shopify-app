import { describe, it, expect } from "vitest";
import { recoveredCentsForAction } from "../audit-impact";

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
