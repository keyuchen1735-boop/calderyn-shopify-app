import { describe, it, expect } from "vitest";
import { recommendDirection, buildDirectionInput, suggestBudgetCents, type DirectionInput } from "../direction.server";
import type { Alert } from "~/lib/types";

const base: DirectionInput = {
  roas: 2,
  breakEvenRoas: 1,
  status: "active",
  hasScalingHeadroom: false,
  pauseAlertActive: false,
};

describe("recommendDirection", () => {
  it("recommends pause when roas is far below break-even (< 0.7x)", () => {
    const r = recommendDirection({ ...base, roas: 0.6, breakEvenRoas: 1 });
    expect(r.direction).toBe("pause");
    expect(r.actionKind).toBe("pause_campaign");
    expect(r.dataSufficient).toBe(true);
  });

  it("recommends pause when a pause-detector alert is active, even if roas is healthy", () => {
    const r = recommendDirection({ ...base, roas: 2, breakEvenRoas: 1, pauseAlertActive: true });
    expect(r.direction).toBe("pause");
  });

  it("recommends scale_down when roas is between 0.7x and 0.95x break-even", () => {
    const r = recommendDirection({ ...base, roas: 0.8, breakEvenRoas: 1 });
    expect(r.direction).toBe("scale_down");
    expect(r.actionKind).toBe("reduce_campaign_budget");
  });

  it("recommends keep when roas is around break-even (0.95x to 1.2x)", () => {
    const r = recommendDirection({ ...base, roas: 1.0, breakEvenRoas: 1 });
    expect(r.direction).toBe("keep");
    expect(r.actionKind).toBeNull();
  });

  it("recommends scale_up when winning (>= 1.2x) AND has scaling headroom", () => {
    const r = recommendDirection({ ...base, roas: 1.5, breakEvenRoas: 1, hasScalingHeadroom: true });
    expect(r.direction).toBe("scale_up");
    expect(r.actionKind).toBe("increase_campaign_budget");
  });

  it("recommends keep when winning but no scaling headroom", () => {
    const r = recommendDirection({ ...base, roas: 1.5, breakEvenRoas: 1, hasScalingHeadroom: false });
    expect(r.direction).toBe("keep");
    expect(r.actionKind).toBeNull();
  });

  it("keeps (paused) without an action when the campaign is paused", () => {
    const r = recommendDirection({ ...base, roas: 0.5, breakEvenRoas: 1, status: "paused" });
    expect(r.direction).toBe("keep");
    expect(r.actionKind).toBeNull();
    expect(r.dataSufficient).toBe(true);
  });

  it("keeps with dataSufficient=false when roas or break-even is null/non-positive", () => {
    expect(recommendDirection({ ...base, roas: null }).dataSufficient).toBe(false);
    expect(recommendDirection({ ...base, breakEvenRoas: null }).dataSufficient).toBe(false);
    expect(recommendDirection({ ...base, breakEvenRoas: 0 }).dataSufficient).toBe(false);
    expect(recommendDirection({ ...base, roas: Infinity }).dataSufficient).toBe(false);
    const r = recommendDirection({ ...base, roas: null });
    expect(r.direction).toBe("keep");
    expect(r.actionKind).toBeNull();
  });

  it("uses the exact grade boundaries: 1.2x is scale-eligible, 0.95x is keep, 0.7x is scale_down", () => {
    expect(recommendDirection({ ...base, roas: 1.2, breakEvenRoas: 1, hasScalingHeadroom: true }).direction).toBe("scale_up");
    expect(recommendDirection({ ...base, roas: 0.95, breakEvenRoas: 1 }).direction).toBe("keep");
    expect(recommendDirection({ ...base, roas: 0.7, breakEvenRoas: 1 }).direction).toBe("scale_down");
    expect(recommendDirection({ ...base, roas: 0.69, breakEvenRoas: 1 }).direction).toBe("pause");
  });

  it("applies thresholds against break-even, not a literal ROAS (break-even = 10)", () => {
    expect(recommendDirection({ ...base, roas: 12, breakEvenRoas: 10, hasScalingHeadroom: true }).direction).toBe("scale_up");
    expect(recommendDirection({ ...base, roas: 11.9, breakEvenRoas: 10 }).direction).toBe("keep");
    expect(recommendDirection({ ...base, roas: 9.5, breakEvenRoas: 10 }).direction).toBe("keep");
    expect(recommendDirection({ ...base, roas: 9.4, breakEvenRoas: 10 }).direction).toBe("scale_down");
    expect(recommendDirection({ ...base, roas: 7.0, breakEvenRoas: 10 }).direction).toBe("scale_down");
    expect(recommendDirection({ ...base, roas: 6.9, breakEvenRoas: 10 }).direction).toBe("pause");
  });
});

const alert = (over: Partial<Alert>): Alert => ({
  id: "a1", detector_id: "campaign_below_breakeven", severity: "high", status: "open",
  dollar_impact: 100, claude_rank: 1, created_at: "", title: "", narrative: "",
  campaign: null, campaign_id: "cmp-1", campaign_external_id: null, sku: null, evidence: {},
  remediation: null, rec_detail: "",
  ...over,
});

describe("buildDirectionInput", () => {
  it("flags pauseAlertActive for an open below-breakeven alert on this campaign", () => {
    const inp = buildDirectionInput({
      campaignId: "cmp-1", roas: 2, breakEvenRoas: 1, status: "active",
      alerts: [alert({ detector_id: "campaign_below_breakeven", status: "open", campaign_id: "cmp-1" })],
    });
    expect(inp.pauseAlertActive).toBe(true);
    expect(inp.hasScalingHeadroom).toBe(false);
  });

  it("flags hasScalingHeadroom for an open scaling-opportunity alert on this campaign", () => {
    const inp = buildDirectionInput({
      campaignId: "cmp-1", roas: 2, breakEvenRoas: 1, status: "active",
      alerts: [alert({ detector_id: "campaign_scaling_opportunity", status: "open", campaign_id: "cmp-1" })],
    });
    expect(inp.hasScalingHeadroom).toBe(true);
    expect(inp.pauseAlertActive).toBe(false);
  });

  it("ignores alerts for other campaigns and non-open alerts", () => {
    const inp = buildDirectionInput({
      campaignId: "cmp-1", roas: 2, breakEvenRoas: 1, status: "active",
      alerts: [
        alert({ detector_id: "campaign_below_breakeven", status: "open", campaign_id: "OTHER" }),
        alert({ detector_id: "campaign_scaling_opportunity", status: "acknowledged", campaign_id: "cmp-1" }),
      ],
    });
    expect(inp.pauseAlertActive).toBe(false);
    expect(inp.hasScalingHeadroom).toBe(false);
  });
});

describe("suggestBudgetCents", () => {
  const gr = { autopilot_max_budget_increase_pct: 20, autopilot_max_budget_cut_pct: 50, autopilot_max_daily_budget_cents: null };
  it("scales up by the increase pct", () => {
    expect(suggestBudgetCents("scale_up", 10000, gr)).toBe(12000);
  });
  it("caps a scale-up at the daily ceiling when set", () => {
    expect(suggestBudgetCents("scale_up", 10000, { ...gr, autopilot_max_daily_budget_cents: 11000 })).toBe(11000);
  });
  it("returns null for scale_up that cannot exceed the current budget", () => {
    expect(suggestBudgetCents("scale_up", 10000, { ...gr, autopilot_max_daily_budget_cents: 10000 })).toBeNull();
  });
  it("scales down by the cut pct", () => {
    expect(suggestBudgetCents("scale_down", 10000, gr)).toBe(5000);
  });
  it("returns null when there is no current budget, or for keep/pause", () => {
    expect(suggestBudgetCents("scale_up", null, gr)).toBeNull();
    expect(suggestBudgetCents("keep", 10000, gr)).toBeNull();
    expect(suggestBudgetCents("pause", 10000, gr)).toBeNull();
  });
  it("falls back to default 20% increase / 50% cut when guardrails are unset", () => {
    expect(suggestBudgetCents("scale_up", 10000, {})).toBe(12000);
    expect(suggestBudgetCents("scale_down", 10000, {})).toBe(5000);
  });
});
