// app/lib/catalog/types.ts
// Shared catalog DTOs consumed by the data layer, the dashboard.api.catalog.*
// routes, and the editor UI (Plan B2).
export type ProductStatus = "draft" | "active" | "archived";

// Search-listing limits, shared by the server validator (hard clamps) and the
// editor's counters/maxLength (soft advisory lengths) so they can't drift.
export const SEO_TITLE_SOFT_MAX = 60;
export const SEO_DESCRIPTION_SOFT_MAX = 160;
export const SEO_TITLE_MAX = 70;
export const SEO_DESCRIPTION_MAX = 200;

/** What the Search-listing card needs: the stored override (null fields = no
 *  override) plus the deterministic defaults the storefront serves without one. */
export interface SeoListingVM {
  metaTitle: string | null;
  metaDescription: string | null;
  defaultTitle: string;
  defaultDescription: string;
  /** Absolute prefix the handle is appended to (".../storefront/products/"). */
  urlPrefix: string;
}

export interface OptionInput {
  name: string;
  values: string[];
}
export interface VariantInput {
  id?: string; // present when editing an existing variant
  sku?: string;
  title?: string;
  retailPriceCents?: number;
  compareAtPriceCents?: number;
  unitCostCents?: number;
  inventoryPolicy?: string;
  inventoryTracked?: boolean;
  inventoryOnHand?: number;
  optionValues?: string[]; // option-value labels this variant represents, e.g. ["M","Red"]
  weightGrams?: number;
  lengthMm?: number;
  widthMm?: number;
  heightMm?: number;
  requiresShipping?: boolean;
  handlingDays?: number;
  signatureRequired?: boolean;
  restrictedCountries?: string[];
}
export interface ProductInput {
  title: string;
  status: ProductStatus;
  /** URL handle. Present only when the merchant edited it (update path); create
   *  keeps generating its own. Normalized by validateProductInput (trim/lowercase,
   *  slug-checked). */
  handle?: string;
  vendor?: string;
  category?: string;
  description?: string;
  tags?: string[];
  options?: OptionInput[];
  variants: VariantInput[];
  collectionIds?: string[];
  /** Search-listing override for an existing-product update. Present only when the payload carried one;
   *  normalized by validateProductInput (trimmed, clamped). Both fields empty
   *  = remove the stored override (the deterministic draft wins again). */
  seo?: { metaTitle: string; metaDescription: string };
}
export interface ProductSummary {
  id: string;
  title: string;
  status: ProductStatus;
  primaryImagePath: string | null;
  variantCount: number;
  updatedAt: string;
}
export interface ProductDetail {
  id: string;
  handle: string;
  title: string;
  status: ProductStatus;
  vendor: string | null;
  category: string | null;
  description: string | null;
  tags: string[];
  options: Array<{ id: string; name: string; values: Array<{ id: string; value: string }> }>;
  variants: Array<{
    id: string;
    sku: string | null;
    title: string;
    retailPriceCents: number | null;
    compareAtPriceCents: number | null;
    unitCostCents: number | null;
    inventoryTracked: boolean | null;
    inventoryOnHand: number;
    optionValueIds: string[];
    weightGrams: number;
    lengthMm: number | null;
    widthMm: number | null;
    heightMm: number | null;
    requiresShipping: boolean;
    handlingDays: number;
    signatureRequired: boolean;
    restrictedCountries: string[];
  }>;
  media: Array<{ id: string; storagePath: string; alt: string | null; position: number; isPrimary: boolean }>;
  collectionIds: string[];
  updatedAt: string;
}
