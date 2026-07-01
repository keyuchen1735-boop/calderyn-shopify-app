// app/lib/catalog/validate.ts
import type { ProductInput, ProductStatus } from "./types";

const STATUSES: ProductStatus[] = ["draft", "active", "archived"];
// The API is the trust boundary (the editor materializes the grid client-side, so
// the happy path self-limits, but a crafted body must not be able to issue an
// unbounded number of sequential inserts). Bounds roughly match Shopify's ceilings.
const MAX_OPTIONS = 3;
const MAX_VALUES_PER_OPTION = 100;
const MAX_VARIANTS = 250;

export function validateProductInput(
  raw: unknown,
): { ok: true; value: ProductInput } | { ok: false; code: string } {
  if (typeof raw !== "object" || raw === null) return { ok: false, code: "invalid_body" };
  const r = raw as Record<string, unknown>;

  const title = typeof r.title === "string" ? r.title.trim() : "";
  if (!title) return { ok: false, code: "missing_title" };
  const status = STATUSES.includes(r.status as ProductStatus) ? (r.status as ProductStatus) : null;
  if (!status) return { ok: false, code: "invalid_status" };
  if (!Array.isArray(r.variants) || r.variants.length === 0) return { ok: false, code: "no_variants" };
  if (r.variants.length > MAX_VARIANTS) return { ok: false, code: "too_many_variants" };

  const variants = (r.variants as unknown[]).map((v) => {
    const o = (typeof v === "object" && v ? v : {}) as Record<string, unknown>;
    return {
      id: typeof o.id === "string" ? o.id : undefined,
      sku: typeof o.sku === "string" ? o.sku : undefined,
      title: typeof o.title === "string" ? o.title : undefined,
      retailPriceCents: Number.isFinite(o.retailPriceCents) ? Number(o.retailPriceCents) : undefined,
      unitCostCents: Number.isFinite(o.unitCostCents) ? Number(o.unitCostCents) : undefined,
      inventoryPolicy: typeof o.inventoryPolicy === "string" ? o.inventoryPolicy : undefined,
      inventoryTracked: typeof o.inventoryTracked === "boolean" ? o.inventoryTracked : undefined,
      inventoryOnHand: Number.isFinite(o.inventoryOnHand) ? Math.max(0, Math.trunc(Number(o.inventoryOnHand))) : 0,
      optionValues: Array.isArray(o.optionValues) ? (o.optionValues as unknown[]).filter((x): x is string => typeof x === "string") : undefined,
      weightGrams: Number.isFinite(o.weightGrams) ? Number(o.weightGrams) : undefined,
      lengthMm: Number.isFinite(o.lengthMm) ? Number(o.lengthMm) : undefined,
      widthMm: Number.isFinite(o.widthMm) ? Number(o.widthMm) : undefined,
      heightMm: Number.isFinite(o.heightMm) ? Number(o.heightMm) : undefined,
      requiresShipping: typeof o.requiresShipping === "boolean" ? o.requiresShipping : undefined,
      handlingDays: Number.isFinite(o.handlingDays) ? Number(o.handlingDays) : undefined,
      signatureRequired: typeof o.signatureRequired === "boolean" ? o.signatureRequired : undefined,
      restrictedCountries: Array.isArray(o.restrictedCountries) ? (o.restrictedCountries as unknown[]).filter((c): c is string => typeof c === "string") : undefined,
    };
  });
  const ISO2 = /^[A-Za-z]{2}$/;
  for (const v of variants) {
    if (v.retailPriceCents != null && v.retailPriceCents < 0) return { ok: false, code: "negative_price" };
    if (v.unitCostCents != null && v.unitCostCents < 0) return { ok: false, code: "negative_cost" };
    if (v.restrictedCountries?.some((c) => !ISO2.test(c))) return { ok: false, code: "invalid_country" };
    // Only ACTIVE products must ship-complete; drafts may be incomplete.
    const physical = v.requiresShipping !== false;
    if (status === "active" && physical) {
      if (!(v.weightGrams && v.weightGrams > 0) || !(v.lengthMm && v.lengthMm > 0) || !(v.widthMm && v.widthMm > 0) || !(v.heightMm && v.heightMm > 0)) {
        return { ok: false, code: "incomplete_shipping" };
      }
    }
  }

  const options = Array.isArray(r.options)
    ? (r.options as unknown[]).map((o) => {
        const oo = (typeof o === "object" && o ? o : {}) as Record<string, unknown>;
        // Trim, drop blanks, and DEDUP values WITHIN an option ("M","M" -> "M") so a
        // duplicate value can't mint two option-value rows pointing at one label.
        // (Repeating a label ACROSS options — Color:Red + Trim:Red — is legitimate
        // and handled by per-option resolution in the write path, so it is kept.)
        const values = [...new Set((Array.isArray(oo.values) ? (oo.values as unknown[]).map(String) : []).map((v) => v.trim()).filter(Boolean))];
        return { name: String(oo.name ?? "").trim(), values };
      }).filter((o) => o.name && o.values.length)
    : undefined;
  if (options && options.length > MAX_OPTIONS) return { ok: false, code: "too_many_options" };
  if (options && options.some((o) => o.values.length > MAX_VALUES_PER_OPTION)) return { ok: false, code: "too_many_option_values" };

  return {
    ok: true,
    value: {
      title,
      status,
      vendor: typeof r.vendor === "string" ? r.vendor : undefined,
      category: typeof r.category === "string" ? r.category : undefined,
      description: typeof r.description === "string" ? r.description : undefined,
      tags: Array.isArray(r.tags) ? (r.tags as unknown[]).filter((t): t is string => typeof t === "string") : undefined,
      options,
      variants,
      collectionIds: Array.isArray(r.collectionIds) ? (r.collectionIds as unknown[]).filter((c): c is string => typeof c === "string") : undefined,
    },
  };
}
