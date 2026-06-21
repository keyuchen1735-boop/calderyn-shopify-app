import { describe, it, expect } from "vitest";
import { buildActionQueue } from "../queue.server";

const alert = (over: Record<string, unknown> = {}) => ({
  id: "a1",
  detector_id: "campaign_below_breakeven",
  severity: "high",
  status: "open",
  dollar_impact: 12000,
  claude_rank: 1,
  created_at: "2026-06-20T00:00:00Z",
  title: "Campaign losing money",
  narrative: "ROAS 0.7",
  campaign: "Camp A",
  campaign_id: "c1",
  campaign_external_id: null,
  sku: null,
  evidence: { campaign_id: "c1" },
  ...over,
});

describe("buildActionQueue", () => {
  it("turns open alerts with a real recommended action into proposals with confidence", () => {
    const q = buildActionQueue([alert()] as never, new Map());
    expect(q).toHaveLength(1);
    expect(q[0].action_kind).toBe("pause_campaign");
    expect(q[0].confidence).toBeGreaterThan(0);
    expect(q[0].dollar_impact).toBe(12000);
    expect(q[0].alertId).toBe("a1");
    expect(q[0].detector_id).toBe("campaign_below_breakeven");
    expect(typeof q[0].reasoning).toBe("string");
  });

  it("skips alerts whose only non-snooze actions are campaign actions and hasCampaign is false", () => {
    // campaign_below_breakeven has only ["pause_campaign", "reduce_campaign_budget", "snooze_alert"]
    // Both non-snooze actions are CAMPAIGN_ACTIONS; with campaign_id:null -> hasCampaign:false -> recommendedAction returns null
    const q = buildActionQueue(
      [alert({ campaign_id: null, evidence: {} })] as never,
      new Map(),
    );
    expect(q).toHaveLength(0);
  });

  it("skips detectors whose only action is snooze (margin_erosion)", () => {
    // margin_erosion: ["snooze_alert"] only — always null
    const q = buildActionQueue(
      [alert({ detector_id: "margin_erosion", campaign_id: null, evidence: {} })] as never,
      new Map(),
    );
    expect(q).toHaveLength(0);
  });

  it("uses pair alpha/beta from the map to compute confidence", () => {
    const pairKey = "campaign_below_breakeven:pause_campaign";
    const map = new Map([[pairKey, { alpha: 10, beta: 2 }]]);
    const q = buildActionQueue([alert()] as never, map);
    expect(q).toHaveLength(1);
    // Higher alpha/beta (more approvals) should give higher confidence than cold-start
    const qCold = buildActionQueue([alert()] as never, new Map());
    expect(q[0].confidence).toBeGreaterThanOrEqual(qCold[0].confidence);
  });

  it("produces a proposal with the expected shape", () => {
    const [p] = buildActionQueue([alert()] as never, new Map());
    expect(p).toMatchObject({
      alertId: "a1",
      detector_id: "campaign_below_breakeven",
      action_kind: "pause_campaign",
      title: "Campaign losing money",
      dollar_impact: 12000,
    });
    expect(typeof p.confidence).toBe("number");
    expect(typeof p.reasoning).toBe("string");
  });
});
