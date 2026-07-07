import { describe, it, expect } from "vitest";
import { buildActionQueue, inventoryOverCapAlertIds } from "../queue.server";

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

  it("surfaces a sku_stockout_cleared alert as a resume_campaign suggestion (Slice B warm-up)", () => {
    const a = alert({
      id: "rc1",
      detector_id: "sku_stockout_cleared",
      title: "Sold-out product is back in stock",
      evidence: { campaign_id: "c1", buffer_units: "30" },
    });
    const q = buildActionQueue([a] as never, new Map(), new Set(), new Set());
    expect(q).toHaveLength(1);
    expect(q[0].action_kind).toBe("resume_campaign");
    expect(q[0].detector_id).toBe("sku_stockout_cleared");
  });

  it("drops the sku_stockout_cleared:resume_campaign proposal once the pair runs autonomously (no double actor)", () => {
    const a = alert({ id: "rc2", detector_id: "sku_stockout_cleared", evidence: { campaign_id: "c1" } });
    const autonomy = new Set(["sku_stockout_cleared:resume_campaign"]);
    const q = buildActionQueue([a] as never, new Map(), new Set(), new Set(), autonomy);
    expect(q).toHaveLength(0);
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

  it("drops a proposal whose detector:action pair is in mutedPairs (non-no-brainer pair)", () => {
    // reorder_timing:create_po_draft is NOT a NO_BRAINER pair → muting removes it entirely.
    const a = alert({ id: "a1", detector_id: "reorder_timing", campaign_id: null, evidence: {} });
    const muted = new Set(["reorder_timing:create_po_draft"]);
    const q = buildActionQueue([a] as never, new Map(), new Set(), muted);
    expect(q).toHaveLength(0);
  });

  it("a muted NO_BRAINER pair stays in the queue as always_ask=true (I8 mute-resistance)", () => {
    // campaign_below_breakeven:pause_campaign IS a NO_BRAINER — muting downgrades
    // it to "always ask" rather than silently removing it (I8).
    const muted = new Set(["campaign_below_breakeven:pause_campaign"]);
    const q = buildActionQueue([alert()] as never, new Map(), new Set(), muted);
    expect(q).toHaveLength(1);
    expect(q[0].always_ask).toBe(true);
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
    // Two alerts with different detectors; mute only the first (non-no-brainer) pair.
    // reorder_timing:create_po_draft is NOT a NO_BRAINER → muted and excluded.
    // negative_unit_economics:pause_campaign is also not a NO_BRAINER → used as the keeper.
    const a1 = alert({ id: "a1", detector_id: "reorder_timing", campaign_id: null, evidence: {} });
    const a2 = alert({ id: "a2", detector_id: "negative_unit_economics", campaign_id: "c2", evidence: { campaign_id: "c2" } });
    const muted = new Set(["reorder_timing:create_po_draft"]);
    const q = buildActionQueue([a1, a2] as never, new Map(), new Set(), muted);
    // a1's pair is muted (non-no-brainer) → excluded; a2 (negative_unit_economics:pause_campaign) survives
    expect(q.every((p) => p.alertId !== "a1")).toBe(true);
    expect(q.some((p) => p.alertId === "a2")).toBe(true);
  });

  it("empty rejectedAlertIds and mutedPairs leaves all valid alerts in queue", () => {
    const q = buildActionQueue([alert()] as never, new Map(), new Set(), new Set());
    expect(q).toHaveLength(1);
  });

  // I5 no-double-actor: pairs RUNNING autonomously (graduated AND enabled) are excluded
  it("drops a proposal whose detector:action pair is in autonomyPairs (running, no double-actor)", () => {
    const running = new Set(["campaign_below_breakeven:pause_campaign"]);
    const q = buildActionQueue([alert()] as never, new Map(), new Set(), new Set(), running);
    expect(q).toHaveLength(0);
  });

  it("keeps a proposal whose pair is NOT in autonomyPairs", () => {
    const running = new Set(["other_detector:pause_campaign"]);
    const q = buildActionQueue([alert()] as never, new Map(), new Set(), new Set(), running);
    expect(q).toHaveLength(1);
    expect(q[0].alertId).toBe("a1");
  });

  it("autonomy (running) exclusion is independent of mutedPairs (both can exclude)", () => {
    const a1 = alert({ id: "a1", detector_id: "campaign_below_breakeven", campaign_id: "c1" });
    const a2 = alert({ id: "a2", detector_id: "reorder_timing", campaign_id: null, evidence: {} });
    // a1's pair is running autonomously; a2's pair is muted
    const running = new Set(["campaign_below_breakeven:pause_campaign"]);
    const muted = new Set(["reorder_timing:create_po_draft"]);
    const q = buildActionQueue([a1, a2] as never, new Map(), new Set(), muted, running);
    expect(q).toHaveLength(0);
  });

  it("a pair not running autonomously, otherwise valid alert is kept", () => {
    // Empty autonomyPairs — nothing is running autonomously
    const q = buildActionQueue([alert()] as never, new Map(), new Set(), new Set(), new Set());
    expect(q).toHaveLength(1);
  });

  // Slice C warm-up: the 5th arg is the set of pairs RUNNING autonomously
  // (graduated AND merchant-enabled). A pair that is graduated/unlocked but the
  // merchant has NOT enabled is absent from that set, so it stays in the queue as
  // a suggestion until the merchant opts in.
  it("keeps a graduated-but-NOT-enabled pair as a suggestion (warm-up)", () => {
    const autonomyPairs = new Set<string>(); // unlocked, but autonomy_enabled=false => not running
    const q = buildActionQueue([alert()] as never, new Map(), new Set(), new Set(), autonomyPairs);
    expect(q).toHaveLength(1);
    expect(q[0].alertId).toBe("a1");
  });

  // (a) Magnitude-awareness: a graduated pair's OVER-CAP alert is blocked by
  // autopilot (block-not-clamp), so it must stay approvable in the queue.
  it("keeps a graduated-pair alert that is in overCapAlertIds, flagged over_autopilot_cap", () => {
    // regional_shortage_risk -> recommendedAction = reallocate_inventory. A real
    // over-cap alert always carries a transfer plan (the over-cap status is
    // derived from its delta), so it passes the runnability gate.
    const a = alert({
      id: "inv1",
      detector_id: "regional_shortage_risk",
      campaign_id: null,
      evidence: { inventory_item_id: "ii1", from_location_id: "l1", to_location_id: "l2", recommended_delta: 50 },
    });
    const graduated = new Set(["regional_shortage_risk:reallocate_inventory"]);
    // Sanity: without the over-cap set, the graduated pair is dropped (I5).
    expect(buildActionQueue([a] as never, new Map(), new Set(), new Set(), graduated)).toHaveLength(0);
    // With the alert flagged over-cap, it is KEPT and marked for manual approval.
    const q = buildActionQueue([a] as never, new Map(), new Set(), new Set(), graduated, new Set(["inv1"]));
    expect(q).toHaveLength(1);
    expect(q[0].alertId).toBe("inv1");
    expect(q[0].action_kind).toBe("reallocate_inventory");
    expect(q[0].over_autopilot_cap).toBe(true);
  });

  it("still drops a graduated-pair alert that is NOT in overCapAlertIds (autopilot handles within-cap)", () => {
    const a = alert({
      id: "inv2",
      detector_id: "regional_shortage_risk",
      campaign_id: null,
      evidence: { inventory_item_id: "ii1", from_location_id: "l1", to_location_id: "l2", recommended_delta: 50 },
    });
    const graduated = new Set(["regional_shortage_risk:reallocate_inventory"]);
    const q = buildActionQueue([a] as never, new Map(), new Set(), new Set(), graduated, new Set(["other"]));
    expect(q).toHaveLength(0);
  });

  it("does not set over_autopilot_cap on a normal (non-graduated) proposal even if its id is in overCapAlertIds", () => {
    // A non-graduated alert is already in the queue normally; the over-cap flag is
    // only meaningful for graduated pairs, so it must not leak onto normal ones.
    const q = buildActionQueue([alert()] as never, new Map(), new Set(), new Set(), new Set(), new Set(["a1"]));
    expect(q).toHaveLength(1);
    expect(q[0].over_autopilot_cap).toBeUndefined();
  });
});

// Rule-12 runnability gate: the queue must only surface an Approve button it can
// actually execute on the alert's data, mirroring the executor preconditions.
describe("buildActionQueue runnability gate", () => {
  const build = (a: Record<string, unknown>) =>
    buildActionQueue([alert(a)] as never, new Map(), new Set(), new Set());

  it("keeps exclude_geo only when the alert has BOTH a campaign id and a valid region", () => {
    // regional_spend_starved_stock -> recommendedAction = exclude_geo.
    const base = { id: "g1", detector_id: "regional_spend_starved_stock", campaign_id: null };
    // complete: campaign_id + valid region in evidence -> kept
    const ok = build({ ...base, evidence: { campaign_id: "c9", region: "us-east" } });
    expect(ok).toHaveLength(1);
    expect(ok[0].action_kind).toBe("exclude_geo");
    // missing region -> dropped (would 422: no valid region bucket)
    expect(build({ ...base, evidence: { campaign_id: "c9" } })).toHaveLength(0);
    // missing campaign -> dropped (would 422: nothing to exclude geo from)
    expect(build({ ...base, evidence: { region: "us-east" } })).toHaveLength(0);
    // invalid region bucket -> dropped
    expect(build({ ...base, evidence: { campaign_id: "c9", region: "europe" } })).toHaveLength(0);
  });

  it("falls back to reallocate_inventory when exclude_geo is non-runnable but a transfer plan exists", () => {
    // regional_spend_starved_stock -> recommendedAction = exclude_geo, but with no
    // campaign it's non-runnable. reallocate_inventory (next in the detector's list)
    // IS runnable via the transfer plan, so the alert must surface THAT instead of
    // being dropped — matching the Alerts screen, which falls back the same way.
    const plan = { inventory_item_id: "ii1", from_location_id: "l1", to_location_id: "l2", recommended_delta: 55 };
    const q = build({ id: "gg1", detector_id: "regional_spend_starved_stock", campaign_id: null, evidence: plan });
    expect(q).toHaveLength(1);
    expect(q[0].action_kind).toBe("reallocate_inventory");
  });

  it("keeps reallocate_inventory only when evidence carries a complete transfer plan", () => {
    const base = { id: "i1", detector_id: "wrong_location_concentration", campaign_id: null };
    const plan = { inventory_item_id: "ii1", from_location_id: "l1", to_location_id: "l2", recommended_delta: 12 };
    expect(build({ ...base, evidence: plan })).toHaveLength(1);
    // partial plan (no destination) -> dropped
    expect(build({ ...base, evidence: { inventory_item_id: "ii1", from_location_id: "l1", recommended_delta: 12 } })).toHaveLength(0);
    // no plan at all -> dropped
    expect(build({ ...base, evidence: {} })).toHaveLength(0);
  });

  it("keeps create_po_draft only when there is a SKU and a derivable reorder quantity", () => {
    const base = { id: "p1", detector_id: "reorder_timing", campaign_id: null };
    // sku + velocity -> derivePoQuantity > 0 -> kept
    expect(build({ ...base, sku: "SKU-1", evidence: { velocity_units_per_day: 3, lead_time_days: 14 } })).toHaveLength(1);
    // sku but no velocity/shortfall -> qty not derivable -> dropped
    expect(build({ ...base, sku: "SKU-1", evidence: {} })).toHaveLength(0);
    // velocity but no sku -> dropped
    expect(build({ ...base, sku: null, evidence: { velocity_units_per_day: 3 } })).toHaveLength(0);
  });

  it("drops a kind with no inline queue executor (reallocate_budget) even with a campaign", () => {
    // ad_tax_overload + campaign -> recommendedAction = reallocate_budget, which
    // deep-links/reviews on Campaigns and has no queue executor (would 422).
    const q = build({ id: "b1", detector_id: "ad_tax_overload", campaign_id: "c1", evidence: { campaign_id: "c1" } });
    expect(q).toHaveLength(0);
  });

  it("keeps a campaign action (pause_campaign) when the campaign id resolves", () => {
    // base alert: campaign_below_breakeven + campaign_id c1 -> pause_campaign.
    expect(buildActionQueue([alert()] as never, new Map(), new Set(), new Set())).toHaveLength(1);
  });
});

// The facade derives which graduated reallocate_inventory alerts are over the
// merchant's per-move unit cap, from the alert's own evidence (exact, no I/O).
const invAlert = (over: Record<string, unknown> = {}) =>
  alert({
    id: "inv1",
    detector_id: "regional_shortage_risk", // recommendedAction -> reallocate_inventory
    campaign_id: null,
    evidence: { inventory_item_id: "ii1", from_location_id: "l1", to_location_id: "l2", recommended_delta: 50 },
    ...over,
  });

describe("inventoryOverCapAlertIds", () => {
  const graduated = new Set(["regional_shortage_risk:reallocate_inventory"]);

  it("flags a graduated reallocate_inventory alert whose |delta| exceeds the cap", () => {
    const ids = inventoryOverCapAlertIds([invAlert()] as never, graduated, 20);
    expect(ids.has("inv1")).toBe(true);
  });

  it("does not flag a within-cap move", () => {
    const ids = inventoryOverCapAlertIds([invAlert()] as never, graduated, 100);
    expect(ids.has("inv1")).toBe(false);
  });

  it("flags nothing when the cap is null (unlimited)", () => {
    const ids = inventoryOverCapAlertIds([invAlert()] as never, graduated, null);
    expect(ids.size).toBe(0);
  });

  it("does not flag an over-cap move on a NON-graduated pair", () => {
    const ids = inventoryOverCapAlertIds([invAlert()] as never, new Set(), 20);
    expect(ids.has("inv1")).toBe(false);
  });

  it("ignores alerts whose recommended action is not reallocate_inventory", () => {
    const ids = inventoryOverCapAlertIds(
      [alert()] as never,
      new Set(["campaign_below_breakeven:pause_campaign"]),
      1,
    );
    expect(ids.size).toBe(0);
  });

  it("ignores an inventory alert with no transfer plan in evidence", () => {
    const ids = inventoryOverCapAlertIds([invAlert({ evidence: {} })] as never, graduated, 1);
    expect(ids.size).toBe(0);
  });

  it("treats a negative delta by magnitude (abs)", () => {
    const ids = inventoryOverCapAlertIds(
      [invAlert({ evidence: { inventory_item_id: "ii1", from_location_id: "l1", to_location_id: "l2", recommended_delta: -50 } })] as never,
      graduated,
      20,
    );
    expect(ids.has("inv1")).toBe(true);
  });
});
