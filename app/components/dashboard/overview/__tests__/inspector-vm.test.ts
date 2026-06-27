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
    expect(vm.signal).toBe("ROAS below break-even 6 days");
    expect(vm.evidence).toEqual(["ROAS 0.8", "Spend $300"]);
    expect(vm.decisionLabel).toBe("DONE AUTOMATICALLY");
    expect(vm.confidence).toBe(82);
    expect(vm.threshold).toBe(75);
    expect(vm.showMoney).toBe(true);
    expect(vm.moneyCents).toBe(42000);
    expect(vm.moneyLabel).toBe("Ad spend protected");
  });

  it("tolerates null factors/confidence on a trace row", () => {
    const vm = inspectorFromTrace(trace({ factors: null, confidence: null }));
    expect(vm.factors).toEqual([]);
    expect(vm.confidence).toBeNull();
  });
});

describe("inspectorFromPending", () => {
  it("builds an inspector from proposal + alert evidence + pipeline factors", () => {
    const vm = inspectorFromPending(prop({}), alert({}), call({}));
    expect(vm.tag).toBe("NEEDS YOU");
    expect(vm.signal).toBe("Out of stock, still spending");
    expect(vm.evidence).toEqual(["stock: 0 units", "spend: $120/day"]);
    expect(vm.factors).toEqual(factors);
    expect(vm.confidence).toBe(70);
    expect(vm.threshold).toBe(75);
    expect(vm.decisionLabel).toBe("NEEDS YOUR APPROVAL");
    expect(vm.moneyLabel).toBe("At stake");
    expect(vm.moneyCents).toBe(12000);
    expect(vm.showMoney).toBe(true);
  });

  it("degrades gracefully when alert/pipeline are missing", () => {
    const vm = inspectorFromPending(
      prop({ detector_id: "margin_erosion", action_kind: "adjust_price", reasoning: "Margin down", confidence: 55 }),
      undefined,
      undefined,
    );
    expect(vm.signal).toBe("Margin down");
    expect(vm.evidence).toEqual([]);
    expect(vm.factors).toEqual([]);
    expect(vm.confidence).toBe(55);
    expect(vm.threshold).toBe(75); // default bar when no pipeline call
  });
});
