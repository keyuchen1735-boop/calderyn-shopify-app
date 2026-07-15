import { describe, expect, it, vi } from "vitest";
import {
  buildGeneratedCampaignDraftState,
  persistGeneratedCampaignDraft,
  type GeneratedCampaignDraftInput,
} from "../campaign-generation-draft.server";
import {
  parseCampaignDraftState,
  type CampaignDraftRow,
  type CampaignDraftState,
} from "../campaign-draft-types";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const PRODUCT_ID = "22222222-2222-4222-8222-222222222222";
const DRAFT_ID = "33333333-3333-4333-8333-333333333333";

function input(
  patch: Partial<GeneratedCampaignDraftInput> = {},
): GeneratedCampaignDraftInput {
  return {
    shopId: "shop-1",
    preferredDraftId: null,
    runId: RUN_ID,
    placement: "instagram",
    productId: PRODUCT_ID,
    productTitle: "Trail pack",
    budgetCents: 1500,
    selectedCreativeIndex: 0,
    attempt: 1,
    response: {
      destinationUrl: "https://shop.example/products/trail-pack",
      imageUrl: "https://cdn.example/product.png",
      fallback: {
        headline: "Carry the trail",
        primaryText: "A balanced pack for every mile.",
        cta: "SHOP_NOW",
      },
      variants: [0, 1, 2].map((index) => ({
        headline: `Direction ${index + 1}`,
        primaryText: `Copy ${index + 1}`,
        cta: "SHOP_NOW",
        rationale: `Reason ${index + 1}`,
        imageUrl: `https://cdn.example/generated-${index + 1}.png`,
        imageGenerated: true,
        score: 90 - index,
      })),
      regenerationsLeft: 2,
    },
    ...patch,
  };
}

function row(state: CampaignDraftState): CampaignDraftRow {
  return {
    id: DRAFT_ID,
    name: state.productTitle,
    platform: "meta",
    createdAt: "2026-07-15T12:00:00.000Z",
    updatedAt: "2026-07-15T12:00:00.000Z",
    state,
  };
}

describe("generated campaign draft persistence", () => {
  it("turns the initial generated set into a complete resumable draft", () => {
    const state = buildGeneratedCampaignDraftState(input(), null);

    expect(state.runId).toBe(RUN_ID);
    expect(state.creativeVariants).toHaveLength(3);
    expect(state.creative.imageUrl).toBe(
      "https://cdn.example/generated-1.png",
    );
    expect(state.selectedCreativeIndex).toBe(0);
    expect(state.regenerationsLeft).toBe(2);
  });

  it("normalizes oversized model text before it can make a draft unresumable", () => {
    const oversized = input();
    oversized.productTitle = "P".repeat(240);
    oversized.response.variants[0] = {
      ...oversized.response.variants[0],
      headline: "H".repeat(80),
      primaryText: "T".repeat(700),
      cta: "C".repeat(60),
      rationale: "R".repeat(800),
    };

    const state = buildGeneratedCampaignDraftState(oversized, null);

    expect(state.productTitle).toHaveLength(200);
    expect(state.creativeVariants[0].headline).toHaveLength(40);
    expect(state.creativeVariants[0].rationale).toHaveLength(500);
    expect(parseCampaignDraftState(state)).toEqual(state);
  });

  it("replaces only the selected saved direction during regeneration", () => {
    const initial = buildGeneratedCampaignDraftState(input(), null);
    const replacement = {
      ...input({
        attempt: 2,
        selectedCreativeIndex: 1,
      }),
      response: {
        ...input().response,
        variants: [
          {
            ...input().response.variants[0],
            headline: "Fresh direction",
            imageUrl: "https://cdn.example/fresh.png",
          },
        ],
        regenerationsLeft: 1,
      },
    };

    const state = buildGeneratedCampaignDraftState(replacement, initial);

    expect(state.creativeVariants.map((variant) => variant.headline)).toEqual([
      "Direction 1",
      "Fresh direction",
      "Direction 3",
    ]);
    expect(state.selectedCreativeIndex).toBe(1);
    expect(state.creative.headline).toBe("Fresh direction");
    expect(state.regenerationsLeft).toBe(1);
  });

  it("updates the run-linked draft instead of creating a duplicate", async () => {
    const initial = buildGeneratedCampaignDraftState(input(), null);
    const existing = row(initial);
    const update = vi.fn(async (_shopId, _id, draftInput) => ({
      ...existing,
      state: draftInput.state ?? null,
    }));
    const create = vi.fn();

    const saved = await persistGeneratedCampaignDraft(input(), {
      findByRunId: vi.fn(async () => existing),
      findById: vi.fn(),
      update,
      create,
    });

    expect(saved.id).toBe(DRAFT_ID);
    expect(update).toHaveBeenCalledWith(
      "shop-1",
      DRAFT_ID,
      expect.objectContaining({ name: "Trail pack", platform: "meta" }),
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("adopts a resumed legacy draft before creating a new row", async () => {
    const legacy: CampaignDraftRow = { ...row(buildGeneratedCampaignDraftState(input(), null)), state: null };
    const update = vi.fn(async (_shopId, _id, draftInput) => ({
      ...legacy,
      state: draftInput.state ?? null,
    }));

    await persistGeneratedCampaignDraft(
      input({ preferredDraftId: DRAFT_ID }),
      {
        findByRunId: vi.fn(async () => null),
        findById: vi.fn(async () => legacy),
        update,
        create: vi.fn(),
      },
    );

    expect(update).toHaveBeenCalledWith(
      "shop-1",
      DRAFT_ID,
      expect.objectContaining({
        state: expect.objectContaining({ runId: RUN_ID }),
      }),
    );
  });
});
