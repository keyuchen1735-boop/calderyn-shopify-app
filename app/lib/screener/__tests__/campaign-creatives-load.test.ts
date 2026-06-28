import { describe, it, expect, vi } from "vitest";
import {
  loadCampaignCreativeScorecards,
  type CreativesLoadDeps,
} from "../campaign-creatives-load.server";
import { DIMENSIONS, type ScoreCard } from "../types";
import type { CampaignCreative } from "../../meta/creatives.server";
import type { AdScorecard } from "../campaign-ads.server";
import type { MetaClient } from "../../meta/campaigns.server";

const fakeMetaClient = {} as MetaClient;

const creativeRow: CampaignCreative = {
  adId: "ad-1", adName: "Ad 1", status: "ACTIVE",
  creative: { imageUrl: null, headline: "h", primaryText: "p", cta: "SHOP_NOW", destinationUrl: "https://x.test/p", audience: "a" },
};

function card(composite: number): ScoreCard {
  return {
    composite, grade: "okay", confidence: "medium", summary: "s",
    metrics: DIMENSIONS.map((d) => ({ id: d.id, group: d.group, label: d.label, score: 70, reasoning: "" })),
    outcomes: {
      estimatedRoas: 2, roasLow: 1, roasHigh: 3, breakEvenRoas: 2, predictedCtr: 0.01,
      holdRate: 0.05, assumedSpendCents: 50000, predictedRevenueCents: 100000, mappedSku: null, skuPriceCents: null,
    },
    tips: [],
  };
}

function deps(over: Partial<CreativesLoadDeps> = {}): CreativesLoadDeps {
  return {
    resolveMetaId: async () => "120999",
    metaClient: async () => ({ client: fakeMetaClient, adAccountId: "act_1" }),
    listCreatives: async () => [creativeRow],
    loadCached: async () => [{ adId: "ad-1", status: "done", scorecard: card(88), error: null } as AdScorecard],
    ...over,
  };
}

describe("loadCampaignCreativeScorecards", () => {
  it("returns creatives + cached scorecards + clamped spend when connected", async () => {
    const out = await loadCampaignCreativeScorecards("s.myshopify.com", "shop-1", "camp-uuid", 60000, deps());
    expect(out.metaConnected).toBe(true);
    expect(out.creatives).toHaveLength(1);
    expect(out.scorecards[0].scorecard?.composite).toBe(88);
    expect(out.assumedSpendCents).toBe(60000);
    expect(out.creativesError).toBeNull();
  });

  it("reports metaConnected:false with empty creatives when Meta is disconnected", async () => {
    const listCreatives = vi.fn();
    const out = await loadCampaignCreativeScorecards("s", "shop-1", "c", 50000, deps({
      metaClient: async () => null, listCreatives,
    }));
    expect(out.metaConnected).toBe(false);
    expect(out.creatives).toEqual([]);
    expect(out.scorecards).toEqual([]);
    expect(listCreatives).not.toHaveBeenCalled();
  });

  it("surfaces a creative-fetch failure honestly without throwing", async () => {
    const out = await loadCampaignCreativeScorecards("s", "shop-1", "c", 50000, deps({
      listCreatives: async () => { throw new Error("graph boom"); },
    }));
    expect(out.metaConnected).toBe(true);
    expect(out.creatives).toEqual([]);
    expect(out.creativesError).toContain("graph boom");
  });

  it("clamps an out-of-range spend to the screener bounds", async () => {
    const out = await loadCampaignCreativeScorecards("s", "shop-1", "c", 1, deps());
    expect(out.assumedSpendCents).toBe(1000); // MIN_SPEND_CENTS
  });
});
