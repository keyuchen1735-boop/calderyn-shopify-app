// adaptAudit must carry undo_of through to the view-model — the dashboard's
// Recovered (7d) tile excludes undo rows exactly like the embedded extension.
import { describe, expect, it } from "vitest";
import { adaptAudit } from "../client";
import type { AuditEntry } from "~/lib/types";

function rawEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: "au-1",
    action_kind: "pause_campaign",
    outcome: "succeeded",
    target: "Prospecting",
    dollar_impact_at_exec: 12_000,
    pre_state: null,
    post_state: null,
    created_at: "2026-06-10T18:00:00.000Z",
    actor: "merchant",
    undo_eligible: true,
    alert_id: null,
    detector_id: "campaign_below_breakeven",
    ...overrides,
  };
}

describe("adaptAudit undo_of mapping", () => {
  it("passes undo_of through for undo rows", () => {
    const vm = adaptAudit(rawEntry({ id: "au-2", undo_of: "au-1" }));
    expect(vm.undo_of).toBe("au-1");
  });

  it("defaults undo_of to null for ordinary rows", () => {
    const vm = adaptAudit(rawEntry());
    expect(vm.undo_of).toBeNull();
  });
});

it("carries the legibility signals (parity with the extension)", () => {
  const vm = adaptAudit({
    id: "a1", action_kind: "pause_campaign", outcome: "succeeded", target: "Meta Summer",
    dollar_impact_at_exec: 100, pre_state: { daily_budget_cents: 1000 }, post_state: { daily_budget_cents: 0 },
    created_at: "2026-06-15T00:00:00Z", actor: "autopilot", undo_eligible: false, alert_id: "al1",
    detector_id: "campaign_below_breakeven",
    trigger_reason: 'Auto-pause: "Campaign is losing money" — $420 at stake, within guardrails',
    cost_sources: [{ kind: "ad_spend", source: "meta" }],
  } as AuditEntry);
  expect(vm.mode).toBe("auto");
  expect(vm.actorDisplay).toBe("Autopilot");
  expect(vm.marginBasis).toBe("alert_estimate");
  expect(vm.costLineage).toEqual([{ kind: "ad_spend", source: "meta" }]);
  expect(vm.why).toContain("Auto-pause");
});
