import { describe, expect, it } from "vitest";
import {
  parseCampaignDraftState,
  validateCampaignDraftInput,
  type CampaignDraftState,
} from "../campaign-draft-types";

const state: CampaignDraftState = {
  version: 1,
  campaignKind: "regular",
  saleType: null,
  runId: "11111111-1111-4111-8111-111111111111",
  placement: "instagram",
  productId: "22222222-2222-4222-8222-222222222222",
  productTitle: "Trail pack",
  productImageUrl: "https://cdn.example/trail-pack.png",
  budgetCents: 1500,
  creative: {
    headline: "Carry the trail",
    primaryText: "A balanced pack for every mile.",
    cta: "SHOP_NOW",
    imageUrl: "https://cdn.example/generated.png",
    destinationUrl: "https://shop.example/products/trail-pack",
    audience: "Broad — United States",
  },
  creativeVariants: [
    {
      headline: "Carry the trail",
      primaryText: "A balanced pack for every mile.",
      cta: "SHOP_NOW",
      rationale: "Clear benefit",
      imageUrl: "https://cdn.example/generated.png",
      imageGenerated: true,
      score: 92,
    },
  ],
  selectedCreativeIndex: 0,
  regenerationsLeft: 1,
};

describe("campaign draft state", () => {
  it("round-trips the complete wizard state", () => {
    expect(parseCampaignDraftState(state)).toEqual(state);
    expect(
      validateCampaignDraftInput({
        name: "Trail pack",
        platform: "meta",
        state,
      }),
    ).toEqual({
      ok: true,
      value: { name: "Trail pack", platform: "meta", state },
    });
  });

  it("keeps legacy name/platform drafts valid", () => {
    expect(
      validateCampaignDraftInput({ name: "Old draft", platform: "google" }),
    ).toEqual({
      ok: true,
      value: { name: "Old draft", platform: "google", state: undefined },
    });
  });

  it("defaults legacy version-1 state to a regular campaign", () => {
    const { campaignKind: _campaignKind, saleType: _saleType, ...legacy } =
      state;

    expect(parseCampaignDraftState(legacy)).toEqual({
      ...state,
      campaignKind: "regular",
      saleType: null,
    });
  });

  it("round-trips a sales campaign and trims its sale type", () => {
    expect(
      parseCampaignDraftState({
        ...state,
        campaignKind: "sales",
        saleType: "  Black Friday  ",
      }),
    ).toEqual({
      ...state,
      campaignKind: "sales",
      saleType: "Black Friday",
    });
  });

  it("rejects sales campaigns without a 1-80 character sale type", () => {
    expect(
      parseCampaignDraftState({
        ...state,
        campaignKind: "sales",
        saleType: "   ",
      }),
    ).toBeNull();
    expect(
      parseCampaignDraftState({
        ...state,
        campaignKind: "sales",
        saleType: "x".repeat(81),
      }),
    ).toBeNull();
  });

  it("accepts a trimmed custom sale type at the 80-character limit", () => {
    const custom = "x".repeat(80);

    expect(
      parseCampaignDraftState({
        ...state,
        campaignKind: "sales",
        saleType: `  ${custom}  `,
      }),
    ).toEqual({
      ...state,
      campaignKind: "sales",
      saleType: custom,
    });
  });

  it("clears a supplied sale type from regular campaigns", () => {
    expect(
      parseCampaignDraftState({
        ...state,
        campaignKind: "regular",
        saleType: "Black Friday",
      }),
    ).toEqual(state);
  });

  it("rejects a placement that disagrees with the stored platform", () => {
    expect(
      validateCampaignDraftInput({
        name: "Mismatch",
        platform: "google",
        state,
      }),
    ).toEqual({
      ok: false,
      code: "platform_state_mismatch",
    });
  });

  it("rejects malformed state instead of partially restoring it", () => {
    expect(
      parseCampaignDraftState({
        ...state,
        creative: { ...state.creative, headline: "" },
      }),
    ).toBeNull();
    expect(
      parseCampaignDraftState({
        ...state,
        creative: {
          ...state.creative,
          destinationUrl: "data:text/html,not-a-destination",
        },
      }),
    ).toBeNull();
    expect(
      parseCampaignDraftState({
        ...state,
        creative: { ...state.creative, destinationUrl: "/relative-product" },
      }),
    ).toBeNull();
    expect(
      parseCampaignDraftState({
        ...state,
        creativeVariants: [{ ...state.creativeVariants[0], primaryText: "" }],
      }),
    ).toBeNull();
  });
});
