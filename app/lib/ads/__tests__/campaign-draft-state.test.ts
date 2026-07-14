import { describe, expect, it } from "vitest";
import {
  parseCampaignDraftState,
  validateCampaignDraftInput,
  type CampaignDraftState,
} from "../campaign-draft-types";

const state: CampaignDraftState = {
  version: 1,
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
