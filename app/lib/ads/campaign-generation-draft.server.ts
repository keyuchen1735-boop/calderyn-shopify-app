import {
  createCampaignDraft,
  getCampaignDraftById,
  getCampaignDraftByRunId,
  updateCampaignDraft,
} from "./campaign-draft.server";
import {
  MAX_CAMPAIGN_DRAFT_NAME_LENGTH,
  type CampaignDraftCreativeVariant,
  type CampaignDraftPlacement,
  type CampaignDraftPlatform,
  type CampaignDraftRow,
  type CampaignDraftState,
} from "./campaign-draft-types";

interface GeneratedVariant {
  headline: string;
  primaryText: string;
  cta: string;
  rationale: string;
  imageUrl: string | null;
  imageGenerated: boolean;
  score: number | null;
}

export interface GeneratedCreativeResponse {
  variants: GeneratedVariant[];
  destinationUrl: string;
  imageUrl: string | null;
  fallback: {
    headline: string;
    primaryText: string;
    cta: string;
  };
  regenerationsLeft: number;
}

export interface GeneratedCampaignDraftInput {
  shopId: string;
  preferredDraftId: string | null;
  runId: string;
  placement: CampaignDraftPlacement;
  productId: string;
  productTitle: string;
  budgetCents: number;
  selectedCreativeIndex: number;
  attempt: number;
  response: GeneratedCreativeResponse;
}

interface GeneratedCampaignDraftDeps {
  findByRunId: typeof getCampaignDraftByRunId;
  findById: typeof getCampaignDraftById;
  create: typeof createCampaignDraft;
  update: typeof updateCampaignDraft;
}

const defaultDeps: GeneratedCampaignDraftDeps = {
  findByRunId: getCampaignDraftByRunId,
  findById: getCampaignDraftById,
  create: createCampaignDraft,
  update: updateCampaignDraft,
};

function clip(value: string, max: number): string {
  return value.trim().slice(0, max);
}

function durableVariant(
  variant: GeneratedVariant,
): CampaignDraftCreativeVariant {
  return {
    headline: clip(variant.headline, 40),
    primaryText: clip(variant.primaryText, 500),
    cta: clip(variant.cta, 40),
    rationale: clip(variant.rationale, 500),
    imageUrl: variant.imageUrl,
    imageGenerated: variant.imageGenerated,
    score: variant.score,
  };
}

function platformForPlacement(
  placement: CampaignDraftPlacement,
): CampaignDraftPlatform {
  if (placement === "google") return "google";
  if (placement === "tiktok") return "tiktok";
  return "meta";
}

function fallbackVariant(
  response: GeneratedCreativeResponse,
): CampaignDraftCreativeVariant {
  return {
    headline: clip(response.fallback.headline, 40),
    primaryText: clip(response.fallback.primaryText, 500),
    cta: clip(response.fallback.cta, 40),
    rationale: "Saved product direction",
    imageUrl: response.imageUrl,
    imageGenerated: false,
    score: null,
  };
}

/** Build a complete resumable state from an initial set or one regenerated
 * direction. Regeneration replaces only the selected slot in the saved set. */
export function buildGeneratedCampaignDraftState(
  input: GeneratedCampaignDraftInput,
  existing: CampaignDraftState | null,
): CampaignDraftState {
  const returned = input.response.variants.map(durableVariant);
  let creativeVariants: CampaignDraftCreativeVariant[];
  if (input.attempt === 1 || !existing?.creativeVariants.length) {
    creativeVariants = returned.length > 0 ? returned : [fallbackVariant(input.response)];
  } else {
    creativeVariants = existing.creativeVariants.map((variant) => ({ ...variant }));
    const replacement = returned[0];
    if (replacement) {
      const replaceAt = Math.min(
        input.selectedCreativeIndex,
        Math.max(creativeVariants.length - 1, 0),
      );
      creativeVariants[replaceAt] = replacement;
    }
  }

  if (creativeVariants.length === 0) {
    creativeVariants = [fallbackVariant(input.response)];
  }
  const selectedCreativeIndex = Math.min(
    input.selectedCreativeIndex,
    creativeVariants.length - 1,
  );
  const selected = creativeVariants[selectedCreativeIndex];
  const productTitle = clip(input.productTitle, 200);
  const productImageUrl =
    input.response.imageUrl ?? existing?.productImageUrl ?? null;

  return {
    version: 1,
    runId: input.runId,
    placement: input.placement,
    productId: input.productId,
    productTitle,
    productImageUrl,
    budgetCents: input.budgetCents,
    creative: {
      headline: selected.headline,
      primaryText: selected.primaryText,
      cta: selected.cta,
      imageUrl:
        selected.imageUrl ??
        input.response.imageUrl ??
        existing?.creative.imageUrl ??
        null,
      destinationUrl: input.response.destinationUrl,
      audience: existing?.creative.audience ?? "Broad, your country",
    },
    creativeVariants,
    selectedCreativeIndex,
    regenerationsLeft: Math.max(
      0,
      Math.min(2, input.response.regenerationsLeft),
    ),
  };
}

/** Save before the generation HTTP response reaches the browser. The run ID is
 * the idempotency key, so replays, refreshes, and manual Save all update one row. */
export async function persistGeneratedCampaignDraft(
  input: GeneratedCampaignDraftInput,
  deps: GeneratedCampaignDraftDeps = defaultDeps,
): Promise<CampaignDraftRow> {
  const byRun = await deps.findByRunId(input.shopId, input.runId);
  const existing =
    byRun ??
    (input.preferredDraftId
      ? await deps.findById(input.shopId, input.preferredDraftId)
      : null);
  const state = buildGeneratedCampaignDraftState(input, existing?.state ?? null);
  const draftInput = {
    name: clip(input.productTitle, MAX_CAMPAIGN_DRAFT_NAME_LENGTH),
    platform: platformForPlacement(input.placement),
    state,
  };

  if (existing) {
    const updated = await deps.update(input.shopId, existing.id, draftInput);
    if (updated) return updated;
  }
  return deps.create(input.shopId, draftInput);
}
