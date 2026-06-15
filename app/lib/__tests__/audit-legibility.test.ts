import { describe, it, expect } from "vitest";
import { auditLegibility } from "../audit-legibility";
import { recoveredCentsFromStates } from "../audit-impact";
import type { AuditEntry } from "../types";

function row(over: Partial<AuditEntry>): AuditEntry {
  return {
    id: "a1", action_kind: "pause_campaign", outcome: "succeeded", target: "Meta Summer",
    dollar_impact_at_exec: 0, pre_state: null, post_state: null, created_at: "2026-06-15T00:00:00Z",
    actor: "merchant", undo_eligible: true, alert_id: null, detector_id: "campaign_below_breakeven",
    ...over,
  } as AuditEntry;
}

describe("auditLegibility — mode", () => {
  it("autopilot actor → auto", () => {
    expect(auditLegibility(row({ actor: "autopilot" })).mode).toBe("auto");
  });
  it("merchant / dashboard / email → manual", () => {
    expect(auditLegibility(row({ actor: "merchant" })).mode).toBe("manual");
    expect(auditLegibility(row({ actor: "merchant:web-dashboard" })).mode).toBe("manual");
    expect(auditLegibility(row({ actor: "jane@store.com" })).mode).toBe("manual");
  });
  it("actorDisplay is normalized", () => {
    expect(auditLegibility(row({ actor: "merchant:web-dashboard" })).actorDisplay).toBe("You (dashboard)");
    expect(auditLegibility(row({ actor: "autopilot" })).actorDisplay).toBe("Autopilot");
  });
});

describe("auditLegibility — marginBasis (provenance)", () => {
  it("alert-attributed value action → alert_estimate", () => {
    const l = auditLegibility(row({ action_kind: "create_po_draft", alert_id: "al1", dollar_impact_at_exec: 466885 }));
    expect(l.marginBasis).toBe("alert_estimate");
    expect(l.marginBasisLabel).toBe("Estimated from alert (at-stake)");
  });
  it("no-alert budget action with pre/post → measured", () => {
    const l = auditLegibility(row({
      action_kind: "reduce_campaign_budget", alert_id: null, dollar_impact_at_exec: 100,
      pre_state: { daily_budget_cents: 1000 }, post_state: { daily_budget_cents: 900 },
    }));
    expect(l.marginBasis).toBe("measured");
  });
  it("zero-impact non-recovering action (snooze) → none", () => {
    const l = auditLegibility(row({ action_kind: "snooze_alert", alert_id: "al1", dollar_impact_at_exec: 0 }));
    expect(l.marginBasis).toBe("none");
  });
  it("zero impact but estimate snapshot present → snapshot", () => {
    const l = auditLegibility(row({
      action_kind: "create_po_draft", alert_id: null, dollar_impact_at_exec: 0,
      post_state: { estimate_cents: 466885 },
    }));
    expect(l.marginBasis).toBe("snapshot");
  });
});

describe("auditLegibility — costLineage", () => {
  it("passes through resolved cost_sources", () => {
    const sources = [{ kind: "cogs" as const, source: "quickbooks" }, { kind: "price" as const, source: "shopify" }];
    expect(auditLegibility(row({ action_kind: "create_po_draft", cost_sources: sources })).costLineage).toEqual(sources);
  });
  it("empty when none resolved", () => {
    expect(auditLegibility(row({ action_kind: "snooze_alert" })).costLineage).toEqual([]);
  });
});

describe("auditLegibility — why", () => {
  it("autopilot prefers the persisted trigger_reason", () => {
    const l = auditLegibility(row({ actor: "autopilot", trigger_reason: "Auto-pause: 'Campaign is losing money' — $420 at stake" }));
    expect(l.why).toContain("Auto-pause");
    expect(l.whyDetail).toContain("$420 at stake");
  });
  it("autopilot without trigger_reason falls back to the detector rule", () => {
    const l = auditLegibility(row({ actor: "autopilot", detector_id: "campaign_below_breakeven", trigger_reason: null }));
    expect(l.why).toBe("Autopilot — Campaign is losing money");
  });
  it("manual with alert → resolved-detector", () => {
    const l = auditLegibility(row({ actor: "merchant", alert_id: "al1", detector_id: "campaign_below_breakeven" }));
    expect(l.why).toBe("Resolved: Campaign is losing money");
  });
  it("manual no-alert from the dashboard → manual-surface", () => {
    const l = auditLegibility(row({ actor: "merchant:web-dashboard", alert_id: null }));
    expect(l.why).toBe("Manual — dashboard");
  });
  it("undo row → reversal", () => {
    const l = auditLegibility(row({ undo_of: "00000000-1111-2222-3333-444444444444" }));
    expect(l.why).toContain("Reversal of");
  });
});

describe("marginBasis anti-drift", () => {
  it("a no-alert budget action that audit-impact measures from states reports 'measured'", () => {
    const pre = { daily_budget_cents: 1000 };
    const post = { daily_budget_cents: 900 };
    expect(recoveredCentsFromStates("reduce_campaign_budget", pre, post)).toBeGreaterThan(0);
    const l = auditLegibility(row({
      action_kind: "reduce_campaign_budget", alert_id: null, dollar_impact_at_exec: 100, pre_state: pre, post_state: post,
    }));
    expect(l.marginBasis).toBe("measured");
  });
});
