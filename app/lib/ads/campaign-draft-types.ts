import { isUuid } from "~/lib/ids";
import type { CampaignKind } from "~/lib/types";

// DTO shapes + input validation shared by the campaign-draft read/write model
// (campaign-draft.server.ts) and the dashboard client/screen. Plain types and
// pure functions only — safe to import from the browser.

export const CAMPAIGN_DRAFT_PLATFORMS = ["meta", "google", "tiktok"] as const;
export type CampaignDraftPlatform = (typeof CAMPAIGN_DRAFT_PLATFORMS)[number];

/** Display labels matching the Platform union the campaigns list renders. */
export const CAMPAIGN_DRAFT_PLATFORM_LABELS: Record<
  CampaignDraftPlatform,
  string
> = {
  meta: "Meta",
  google: "Google",
  tiktok: "TikTok",
};

export const MAX_CAMPAIGN_DRAFT_NAME_LENGTH = 120;
export const MAX_CAMPAIGN_SALE_TYPE_LENGTH = 80;
export const CAMPAIGN_SALE_TYPES = [
  "Black Friday",
  "Cyber Monday",
  "Holiday",
  "Seasonal",
  "General Sale",
] as const;

export interface CampaignClassificationInput {
  campaignKind: CampaignKind;
  saleType: string | null;
}

export function parseCampaignClassification(
  campaignKind: unknown,
  saleType: unknown,
): CampaignClassificationInput | null {
  if (campaignKind === undefined || campaignKind === "regular") {
    return { campaignKind: "regular", saleType: null };
  }
  if (campaignKind !== "sales" || typeof saleType !== "string") return null;
  const normalizedSaleType = saleType.trim();
  if (
    !normalizedSaleType ||
    normalizedSaleType.length > MAX_CAMPAIGN_SALE_TYPE_LENGTH
  )
    return null;
  return { campaignKind: "sales", saleType: normalizedSaleType };
}

export const CAMPAIGN_DRAFT_PLACEMENTS = [
  "facebook",
  "instagram",
  "google",
  "tiktok",
] as const;
export type CampaignDraftPlacement = (typeof CAMPAIGN_DRAFT_PLACEMENTS)[number];

export interface CampaignDraftCreative {
  headline: string;
  primaryText: string;
  cta: string;
  imageUrl: string | null;
  destinationUrl: string;
  audience: string;
}

export interface CampaignDraftCreativeVariant {
  headline: string;
  primaryText: string;
  cta: string;
  rationale: string;
  imageUrl: string | null;
  imageGenerated: boolean;
  score: number | null;
}

/** Versioned, browser-safe state needed to resume the five-step campaign flow. */
export interface CampaignDraftState {
  version: 1;
  campaignKind: CampaignKind;
  saleType: string | null;
  runId: string;
  placement: CampaignDraftPlacement;
  productId: string;
  productTitle: string;
  productImageUrl: string | null;
  budgetCents: number;
  creative: CampaignDraftCreative;
  creativeVariants: CampaignDraftCreativeVariant[];
  selectedCreativeIndex: number;
  regenerationsLeft: number;
}

export interface CampaignDraftRow {
  id: string;
  name: string;
  platform: CampaignDraftPlatform;
  createdAt: string;
  updatedAt: string;
  state: CampaignDraftState | null;
}

export interface CampaignDraftInput {
  name: string;
  platform: CampaignDraftPlatform;
  state?: CampaignDraftState;
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= max ? normalized : null;
}

function optionalUrl(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

/** Strictly narrow persisted JSON before it reaches the wizard reducer. */
export function parseCampaignDraftState(
  raw: unknown,
): CampaignDraftState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (value.version !== 1) return null;

  const classification = parseCampaignClassification(
    value.campaignKind,
    value.saleType,
  );
  if (!classification) return null;

  const runId = text(value.runId, 36);
  const productId = text(value.productId, 36);
  const productTitle = text(value.productTitle, 200);
  const placement = CAMPAIGN_DRAFT_PLACEMENTS.includes(
    value.placement as CampaignDraftPlacement,
  )
    ? (value.placement as CampaignDraftPlacement)
    : null;
  const productImageUrl = optionalUrl(value.productImageUrl);
  const budgetCents = Number(value.budgetCents);
  const selectedCreativeIndex = Number(value.selectedCreativeIndex);
  const regenerationsLeft = Number(value.regenerationsLeft);
  const creativeRaw = value.creative as Record<string, unknown> | null;
  if (
    !runId ||
    !isUuid(runId) ||
    !productId ||
    !isUuid(productId) ||
    !productTitle ||
    !placement ||
    productImageUrl === undefined ||
    !Number.isInteger(budgetCents) ||
    budgetCents < 500 ||
    budgetCents > 20000 ||
    !Number.isInteger(selectedCreativeIndex) ||
    selectedCreativeIndex < 0 ||
    !Number.isInteger(regenerationsLeft) ||
    regenerationsLeft < 0 ||
    regenerationsLeft > 2 ||
    !creativeRaw
  )
    return null;

  const imageUrl = optionalUrl(creativeRaw.imageUrl);
  const destinationUrl = optionalUrl(creativeRaw.destinationUrl);
  const creative: CampaignDraftCreative = {
    headline: text(creativeRaw.headline, 40) ?? "",
    primaryText: text(creativeRaw.primaryText, 500) ?? "",
    cta: text(creativeRaw.cta, 40) ?? "",
    imageUrl: imageUrl === undefined ? null : imageUrl,
    destinationUrl: typeof destinationUrl === "string" ? destinationUrl : "",
    audience: text(creativeRaw.audience, 160) ?? "",
  };
  if (
    !creative.headline ||
    !creative.primaryText ||
    !creative.cta ||
    !creative.destinationUrl ||
    imageUrl === undefined ||
    destinationUrl === undefined
  )
    return null;

  const variantsRaw = Array.isArray(value.creativeVariants)
    ? value.creativeVariants.slice(0, 3)
    : [];
  const creativeVariants: CampaignDraftCreativeVariant[] = [];
  for (const item of variantsRaw) {
    if (typeof item !== "object" || item === null) return null;
    const variant = item as Record<string, unknown>;
    const variantImage = optionalUrl(variant.imageUrl);
    const score = variant.score === null ? null : Number(variant.score);
    const parsed: CampaignDraftCreativeVariant = {
      headline: text(variant.headline, 40) ?? "",
      primaryText: text(variant.primaryText, 500) ?? "",
      cta: text(variant.cta, 40) ?? "",
      rationale: text(variant.rationale, 500) ?? "",
      imageUrl: variantImage === undefined ? null : variantImage,
      imageGenerated: variant.imageGenerated === true,
      score,
    };
    if (
      !parsed.headline ||
      !parsed.primaryText ||
      !parsed.cta ||
      variantImage === undefined ||
      (score !== null && (!Number.isFinite(score) || score < 0 || score > 100))
    )
      return null;
    creativeVariants.push(parsed);
  }
  if (selectedCreativeIndex >= Math.max(creativeVariants.length, 1))
    return null;

  return {
    version: 1,
    ...classification,
    runId,
    placement,
    productId,
    productTitle,
    productImageUrl,
    budgetCents,
    creative,
    creativeVariants,
    selectedCreativeIndex,
    regenerationsLeft,
  };
}

/** Validate an untrusted JSON body at the API boundary: name 1–120 chars after
 *  trimming, platform one of the fixed set. Never trusts the inbound shape. */
export function validateCampaignDraftInput(
  raw: unknown,
): { ok: true; value: CampaignDraftInput } | { ok: false; code: string } {
  if (typeof raw !== "object" || raw === null)
    return { ok: false, code: "invalid_body" };
  const r = raw as Record<string, unknown>;

  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!name) return { ok: false, code: "missing_name" };
  if (name.length > MAX_CAMPAIGN_DRAFT_NAME_LENGTH)
    return { ok: false, code: "name_too_long" };

  const platform = CAMPAIGN_DRAFT_PLATFORMS.includes(
    r.platform as CampaignDraftPlatform,
  )
    ? (r.platform as CampaignDraftPlatform)
    : null;
  if (!platform) return { ok: false, code: "invalid_platform" };

  const state =
    r.state === undefined ? undefined : parseCampaignDraftState(r.state);
  if (r.state !== undefined && !state)
    return { ok: false, code: "invalid_state" };

  if (state) {
    const placementPlatform =
      state.placement === "google"
        ? "google"
        : state.placement === "tiktok"
          ? "tiktok"
          : "meta";
    if (placementPlatform !== platform)
      return { ok: false, code: "platform_state_mismatch" };
  }

  return { ok: true, value: { name, platform, state: state ?? undefined } };
}
