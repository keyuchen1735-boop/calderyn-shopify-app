import type { StoreTemplateId } from "~/lib/storefront-bundle/types";

const REVIEW_TEMPLATE_IDS = new Set<StoreTemplateId>([
  "volt", "atelier", "gilt", "ember", "roast", "fizz", "forge", "haven", "glow",
]);

export function isStorefrontRecipeReviewEnabled(): boolean {
  return process.env.VERCEL_ENV ? process.env.VERCEL_ENV === "preview" : process.env.NODE_ENV !== "production";
}

export function isStorefrontRecipeReviewTemplateId(value: string | null | undefined): value is StoreTemplateId {
  return Boolean(value) && REVIEW_TEMPLATE_IDS.has(value as StoreTemplateId);
}
