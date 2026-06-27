import { describe, it, expect } from "vitest";
import {
  buildFeatureGroups,
  countEnabled,
  countTotal,
  flaggedGroups,
  domainForDetector,
  catalogName,
  FEATURE_CATALOG,
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
  it("returns the four groups in fixed order; one unlocked feature, the rest of the catalog locked", () => {
    const groups = buildFeatureGroups([feat({ enabled: true })]);
    expect(groups.map((g) => g.key)).toEqual(["ads", "inv", "price", "ret"]);
    expect(countEnabled(groups)).toBe(1); // the one graduated, enabled feature
    // The unlocked detector IS in the catalog, so it replaces its locked entry:
    // total rows == the full catalog.
    expect(countTotal(groups)).toBe(FEATURE_CATALOG.length);
  });

  it("shows the full catalog as locked rows when nothing is unlocked", () => {
    const groups = buildFeatureGroups([]);
    expect(countEnabled(groups)).toBe(0);
    expect(countTotal(groups)).toBe(FEATURE_CATALOG.length);
    // every row is locked, and a known catalog feature is present
    const allRows = groups.flatMap((g) => g.rows);
    expect(allRows.every((r) => r.locked)).toBe(true);
    const inv = groups.find((g) => g.key === "inv")!;
    expect(inv.rows.some((r) => r.detectorId === "sku_stockout_vs_spend")).toBe(true);
  });

  it("does not duplicate an unlocked detector as a locked catalog row", () => {
    const groups = buildFeatureGroups([
      feat({ detectorId: "sku_stockout_vs_spend", actionKind: "pause_campaign" }),
    ]);
    const inv = groups.find((g) => g.key === "inv")!;
    const rows = inv.rows.filter((r) => r.detectorId === "sku_stockout_vs_spend");
    expect(rows).toHaveLength(1);
    expect(rows[0].locked).toBe(false);
  });

  it("uses the simpler catalog display name for an unlocked feature", () => {
    const groups = buildFeatureGroups([
      feat({ detectorId: "campaign_below_breakeven", name: "Pause money-losing campaigns" }),
    ]);
    const ads = groups.find((g) => g.key === "ads")!;
    const row = ads.rows.find((r) => r.detectorId === "campaign_below_breakeven")!;
    expect(row.name).toBe(catalogName("campaign_below_breakeven", "fallback"));
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
