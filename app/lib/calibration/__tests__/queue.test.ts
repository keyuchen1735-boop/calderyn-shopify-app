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
    const q = buildActionQueue([alert()] as never, new Map(), new Set(), new Set());
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
      new Set(),
      new Set(),
    );
    expect(q).toHaveLength(0);
  });

  it("skips detectors whose only action is snooze (margin_erosion)", () => {
    // margin_erosion: ["snooze_alert"] only — always null
    const q = buildActionQueue(
      [alert({ detector_id: "margin_erosion", campaign_id: null, evidence: {} })] as never,
      new Map(),
      new Set(),
      new Set(),
    );
    expect(q).toHaveLength(0);
  });

  it("uses pair alpha/beta from the map to compute confidence", () => {
    const pairKey = "campaign_below_breakeven:pause_campaign";
    const map = new Map([[pairKey, { alpha: 10, beta: 2 }]]);
    const q = buildActionQueue([alert()] as never, map, new Set(), new Set());
    expect(q).toHaveLength(1);
    // Higher alpha/beta (more approvals) should give higher confidence than cold-start
    const qCold = buildActionQueue([alert()] as never, new Map(), new Set(), new Set());
    expect(q[0].confidence).toBeGreaterThanOrEqual(qCold[0].confidence);
  });

  it("produces a proposal with the expected shape", () => {
    const [p] = buildActionQueue([alert()] as never, new Map(), new Set(), new Set());
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

  it("drops an alert whose id is in rejectedAlertIds", () => {
    const rejected = new Set(["a1"]);
    const q = buildActionQueue([alert()] as never, new Map(), rejected, new Set());
    expect(q).toHaveLength(0);
  });

  it("keeps alerts whose id is NOT in rejectedAlertIds", () => {
    const rejected = new Set(["other-id"]);
    const q = buildActionQueue([alert()] as never, new Map(), rejected, new Set());
    expect(q).toHaveLength(1);
    expect(q[0].alertId).toBe("a1");
  });

  it("drops a proposal whose detector:action pair is in mutedPairs", () => {
    const muted = new Set(["campaign_below_breakeven:pause_campaign"]);
    const q = buildActionQueue([alert()] as never, new Map(), new Set(), muted);
    expect(q).toHaveLength(0);
  });

  it("keeps a proposal whose detector:action pair is NOT in mutedPairs", () => {
    const muted = new Set(["other_detector:pause_campaign"]);
    const q = buildActionQueue([alert()] as never, new Map(), new Set(), muted);
    expect(q).toHaveLength(1);
    expect(q[0].alertId).toBe("a1");
  });

  it("drops alert by rejectedAlertIds but keeps another alert not in the set", () => {
    const a2 = alert({ id: "a2", campaign_id: "c2" });
    const rejected = new Set(["a1"]);
    const q = buildActionQueue([alert(), a2] as never, new Map(), rejected, new Set());
    expect(q).toHaveLength(1);
    expect(q[0].alertId).toBe("a2");
  });

  it("drops proposal by mutedPairs but keeps another proposal with a different pair", () => {
    // Two alerts with different detectors; mute only the first pair.
    // reorder_timing -> create_po_draft (non-campaign action, works without campaign_id).
    const a1 = alert({ id: "a1", detector_id: "campaign_below_breakeven", campaign_id: "c1" });
    const a2 = alert({ id: "a2", detector_id: "reorder_timing", campaign_id: null, evidence: {} });
    const muted = new Set(["campaign_below_breakeven:pause_campaign"]);
    const q = buildActionQueue([a1, a2] as never, new Map(), new Set(), muted);
    // a1's pair is muted; a2 (reorder_timing:create_po_draft) must survive
    expect(q.every((p) => p.alertId !== "a1")).toBe(true);
    expect(q.some((p) => p.alertId === "a2")).toBe(true);
  });

  it("empty rejectedAlertIds and mutedPairs leaves all valid alerts in queue", () => {
    const q = buildActionQueue([alert()] as never, new Map(), new Set(), new Set());
    expect(q).toHaveLength(1);
  });
});
