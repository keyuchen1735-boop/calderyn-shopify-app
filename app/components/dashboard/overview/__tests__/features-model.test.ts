import { describe, it, expect } from "vitest";
import {
  buildFeatureGroups,
  countEnabled,
  countTotal,
  flaggedGroups,
  domainForDetector,
} from "../features-model";
import type { LiveEngineFeatureVM } from "~/lib/calibration/live-engine-types";
import type { QueueProposalVM } from "~/components/dashboard/view-models";

const feat = (o: Partial<LiveEngineFeatureVM>): LiveEngineFeatureVM => ({
  detectorId: "campaign_below_breakeven",
  actionKind: "pause_campaign",
  name: "Pause campaign",
  watching: "Campaign is losing money",
  enabled: true,
  moneyCents: 0,
  actions: 0,
  lastAt: null,
  lastText: "no actions yet",
  approvals: 3,
  approvalsNeeded: 3,
  outcomes: 3,
  outcomesNeeded: 3,
  proven: true,
  recommended: false,
  ...o,
});

const prop = (o: Partial<QueueProposalVM>): QueueProposalVM => ({
  alertId: "a1",
  detector_id: "sku_stockout_vs_spend",
  action_kind: "pause_campaign",
  title: "Sold-out product still running ads",
  dollar_impact: 12000,
  confidence: 70,
  reasoning: "Out of stock",
  ...o,
});

describe("domainForDetector", () => {
  it("maps each domain", () => {
    expect(domainForDetector("campaign_below_breakeven")).toBe("ads");
    expect(domainForDetector("sku_stockout_vs_spend")).toBe("inv");
    expect(domainForDetector("margin_erosion")).toBe("price");
    expect(domainForDetector("return_rate_hidden_loss")).toBe("ret");
    expect(domainForDetector("unknown_xyz")).toBe("ads"); // safe default
  });
});

describe("buildFeatureGroups", () => {
  it("returns the four groups in fixed order and counts enabled vs total", () => {
    const groups = buildFeatureGroups([feat({ enabled: true })], [prop({})]);
    expect(groups.map((g) => g.key)).toEqual(["ads", "inv", "price", "ret"]);
    expect(countEnabled(groups)).toBe(1); // the graduated, enabled feature
    expect(countTotal(groups)).toBe(2); // graduated ads + locked inv pending
  });

  it("marks pending-only rows as locked", () => {
    const groups = buildFeatureGroups([], [prop({ detector_id: "sku_stockout_vs_spend" })]);
    const inv = groups.find((g) => g.key === "inv")!;
    expect(inv.rows.some((r) => r.locked)).toBe(true);
    expect(inv.onCount).toBe(0);
  });

  it("dedupes a (detector,action) present in both graduated and pending", () => {
    const groups = buildFeatureGroups(
      [feat({ detectorId: "sku_stockout_vs_spend", actionKind: "pause_campaign" })],
      [prop({ detector_id: "sku_stockout_vs_spend", action_kind: "pause_campaign" })],
    );
    const inv = groups.find((g) => g.key === "inv")!;
    expect(
      inv.rows.filter(
        (r) => r.detectorId === "sku_stockout_vs_spend" && r.actionKind === "pause_campaign",
      ),
    ).toHaveLength(1);
  });
});

describe("flaggedGroups", () => {
  it("flags the domain of each pending item", () => {
    const set = flaggedGroups([
      prop({ detector_id: "margin_erosion" }),
      prop({ detector_id: "sku_stockout_vs_spend" }),
    ]);
    expect(set.has("price")).toBe(true);
    expect(set.has("inv")).toBe(true);
    expect(set.has("ads")).toBe(false);
  });
});
