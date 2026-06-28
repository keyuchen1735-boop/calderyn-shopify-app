import { describe, it, expect } from "vitest";
import { inspectorFromTrace, inspectorFromPending } from "../inspector-vm";
import type { TraceEventVM, PipelineCallVM } from "~/lib/calibration/live-engine-types";
import type { AlertVM, QueueProposalVM } from "~/components/dashboard/view-models";

const factors = [{ key: "hist", label: "Track record", value: 80, weight: 0.5 }];

const trace = (o: Partial<TraceEventVM>): TraceEventVM => ({
  id: "1",
  tag: "AUTO",
  detectorId: "campaign_below_breakeven",
  actionKind: "pause_campaign",
  text: "Paused X",
  moneyCents: 42000,
  time: "09:12",
  rel: "12 min ago",
  title: "Paused X",
  signal: "ROAS below break-even 6 days",
  evidence: ["ROAS 0.8", "Spend $300"],
  factors,
  confidence: 82,
  threshold: 75,
  decisionLabel: "DONE AUTOMATICALLY",
  decisionNote: "Above the bar.",
  ...o,
});

const alert = (o: Partial<AlertVM>): AlertVM => ({
  id: "a1",
  detector_id: "sku_stockout_vs_spend",
  severity: "high",
  status: "open",
  claude_rank: 1,
  dollar_impact: 12000,
  created_at: "2026-06-26T00:00:00Z",
  title: "Sold-out product still running ads",
  campaign: null,
  campaign_id: null,
  sku: null,
  narrative: "Out of stock, still spending",
  evidence: { stock: "0 units", spend: "$120/day" },
  actions: ["pause_campaign"],
  recommended: "pause_campaign",
  rec_detail: "",
  remediation: null,
  ...o,
});

const prop = (o: Partial<QueueProposalVM>): QueueProposalVM => ({
  alertId: "a1",
  detector_id: "sku_stockout_vs_spend",
  action_kind: "pause_campaign",
  title: "Sold-out product still running ads",
  dollar_impact: 12000,
  confidence: 70,
  reasoning: "Out of stock, still spending",
  ...o,
});

const call = (o: Partial<PipelineCallVM>): PipelineCallVM => ({
  detectorId: "sku_stockout_vs_spend",
  actionKind: "pause_campaign",
  title: "Pause",
  context: "Out of stock",
  factors,
  confidence: 70,
  threshold: 75,
  auto: false,
  ...o,
});

describe("inspectorFromTrace", () => {
  it("passes through trace inspector fields", () => {
    const vm = inspectorFromTrace(trace({}));
    expect(vm.variant).toBe("trace");
    expect(vm.signal).toBe("ROAS below break-even 6 days");
    expect(vm.evidence).toEqual(["ROAS 0.8", "Spend $300"]);
    expect(vm.stats).toEqual([]);
    expect(vm.decisionLabel).toBe("DONE AUTOMATICALLY");
    expect(vm.confidence).toBe(82);
    expect(vm.threshold).toBe(75);
    expect(vm.showMoney).toBe(true);
    expect(vm.moneyCents).toBe(42000);
    expect(vm.moneyLabel).toBe("Ad spend protected");
    // History rows carry no approve/deny framing.
    expect(vm.approveText).toBeNull();
    expect(vm.denyText).toBeNull();
    expect(vm.trustLine).toBeNull();
  });

  it("tolerates null factors/confidence on a trace row", () => {
    const vm = inspectorFromTrace(trace({ factors: null, confidence: null }));
    expect(vm.factors).toEqual([]);
    expect(vm.confidence).toBeNull();
  });
});

describe("inspectorFromPending", () => {
  it("frames the decision as approve/deny outcomes with a plain trust line", () => {
    const vm = inspectorFromPending(prop({ action_kind: "reallocate_inventory" }), alert({}), call({}));
    expect(vm.variant).toBe("pending");
    expect(vm.tag).toBe("NEEDS YOU");
    expect(vm.signal).toBe("Out of stock, still spending");
    expect(vm.factors).toEqual(factors);
    expect(vm.confidence).toBe(70);
    expect(vm.threshold).toBe(75);
    expect(vm.decisionLabel).toBe("NEEDS YOUR APPROVAL");
    expect(vm.moneyLabel).toBe("At stake");
    expect(vm.moneyCents).toBe(12000);
    expect(vm.showMoney).toBe(true);
    // Approve copy names the action in plain language; deny + trust are present.
    expect(vm.approveText).toBe("Calderyn will reallocate inventory now. You can undo it anytime from your history.");
    expect(vm.denyText).toContain("Nothing changes");
    expect(vm.trustLine).toContain("Still learning this one");
  });

  it("humanizes alert evidence into figures, suppressing internal IDs and the product name", () => {
    const vm = inspectorFromPending(
      prop({}),
      alert({
        evidence: {
          inventory_item_id: "gid://shopify/InventoryItem/1",
          title: "Cascade Rain Shell — M",
          stock_concentration_pct: "92.7",
          demand_share_pct: "11.4",
          location_region: "us-west",
        },
      }),
      call({}),
    );
    // Raw key:value dump is gone; the legacy `evidence` chips are empty.
    expect(vm.evidence).toEqual([]);
    // Internal id + redundant product name dropped; the rest humanized + formatted.
    expect(vm.stats).toEqual([
      { label: "Stock kept in this region", value: "92.7%" },
      { label: "Sales from this region", value: "11.4%" },
      { label: "Region", value: "us-west" },
    ]);
  });

  it("caps the figures so the panel stays glanceable", () => {
    const vm = inspectorFromPending(
      prop({}),
      alert({ evidence: { a_units: "1", b_units: "2", c_units: "3", d_units: "4" } }),
      call({}),
    );
    expect(vm.stats).toHaveLength(3);
  });

  it("degrades gracefully when alert/pipeline are missing", () => {
    const vm = inspectorFromPending(
      prop({ detector_id: "margin_erosion", action_kind: "adjust_price", reasoning: "Margin down", confidence: 55 }),
      undefined,
      undefined,
    );
    expect(vm.signal).toBe("Margin down");
    expect(vm.evidence).toEqual([]);
    expect(vm.stats).toEqual([]);
    expect(vm.factors).toEqual([]);
    expect(vm.confidence).toBe(55);
    expect(vm.threshold).toBe(75); // default bar when no pipeline call
  });
});
