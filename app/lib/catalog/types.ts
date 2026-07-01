// app/lib/catalog/types.ts
// Shared catalog DTOs consumed by the data layer, the dashboard.api.catalog.*
// routes, and the editor UI (Plan B2).
export type ProductStatus = "draft" | "active" | "archived";

export interface OptionInput {
  name: string;
  values: string[];
}
export interface VariantInput {
  id?: string; // present when editing an existing variant
  sku?: string;
  title?: string;
  retailPriceCents?: number;
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
  vendor?: string;
  category?: string;
  description?: string;
  tags?: string[];
  options?: OptionInput[];
  variants: VariantInput[];
  collectionIds?: string[];
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
    unitCostCents: number | null;
    inventoryTracked: boolean | null;
    inventoryOnHand: number;
    optionValueIds: string[];
  }>;
  media: Array<{ id: string; storagePath: string; alt: string | null; position: number; isPrimary: boolean }>;
  collectionIds: string[];
  updatedAt: string;
}
