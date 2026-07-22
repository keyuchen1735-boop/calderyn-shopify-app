import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildChain,
  getRecorded,
  resetRecorded,
  setSupabaseResponse,
} from "../../__tests__/_supabase_chain_mock";
import { createCampaignDraft } from "../campaign-draft.server";
import type { CampaignDraftState } from "../campaign-draft-types";

vi.mock("../../supabase.server", () => ({
  getSupabase: () => buildChain(),
}));

const state: CampaignDraftState = {
  version: 1,
  campaignKind: "regular",
  saleType: null,
  runId: "11111111-1111-4111-8111-111111111111",
  placement: "instagram",
  productId: "22222222-2222-4222-8222-222222222222",
  productTitle: "Trail pack",
  productImageUrl: "https://cdn.example/product.png",
  budgetCents: 1500,
  creative: {
    headline: "Carry the trail",
    primaryText: "A balanced pack for every mile.",
    cta: "SHOP_NOW",
    imageUrl: "https://cdn.example/generated.png",
    destinationUrl: "https://shop.example/products/trail-pack",
    audience: "Broad, your country",
  },
  creativeVariants: [],
  selectedCreativeIndex: 0,
  regenerationsLeft: 2,
};

describe("campaign draft server", () => {
  beforeEach(resetRecorded);

  it("upserts a complete wizard draft by shop and run ID", async () => {
    setSupabaseResponse({
      data: {
        id: "33333333-3333-4333-8333-333333333333",
        name: "Trail pack",
        platform: "meta",
        created_at: "2026-07-15T12:00:00.000Z",
        updated_at: "2026-07-15T12:00:00.000Z",
        state,
      },
      error: null,
    });

    await createCampaignDraft("shop-1", {
      name: "Trail pack",
      platform: "meta",
      state,
    });

    expect(getRecorded("upsert")[0]).toEqual([
      expect.objectContaining({
        shop_id: "shop-1",
        run_id: state.runId,
        state,
      }),
      { onConflict: "shop_id,run_id" },
    ]);
    expect(getRecorded("insert")).toHaveLength(0);
  });
});
