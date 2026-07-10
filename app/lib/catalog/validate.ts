// app/lib/catalog/validate.ts
import { PRODUCT_HANDLE_RE, PRODUCT_HANDLE_MAX } from "./handle";
import { SEO_TITLE_MAX, SEO_DESCRIPTION_MAX } from "./types";
import type { ProductInput, ProductStatus } from "./types";

const STATUSES: ProductStatus[] = ["draft", "active", "archived"];
// The API is the trust boundary (the editor materializes the grid client-side, so
// the happy path self-limits, but a crafted body must not be able to issue an
// unbounded number of sequential inserts). Bounds roughly match Shopify's ceilings.
const MAX_OPTIONS = 3;
const MAX_VALUES_PER_OPTION = 100;
const MAX_VARIANTS = 250;
// retail_price_cents / unit_cost_cents / inventory_on_hand are Postgres int4;
// values past this ceiling overflow the column and surface as an opaque 500.
const INT4_MAX = 2147483647;
// Clamp to a maximum number of Unicode code points. A plain .slice() counts
// UTF-16 units and can cut a surrogate pair in half (an emoji at the boundary
// becomes a lone surrogate, rendered as U+FFFD in the PDP title).
function clampCodePoints(s: string, max: number): string {
  const points = Array.from(s);
  return points.length <= max ? s : points.slice(0, max).join("");
}

export function validateProductInput(
  raw: unknown,
): { ok: true; value: ProductInput } | { ok: false; code: string } {
  if (typeof raw !== "object" || raw === null) return { ok: false, code: "invalid_body" };
  const r = raw as Record<string, unknown>;

  const title = typeof r.title === "string" ? r.title.trim() : "";
  if (!title) return { ok: false, code: "missing_title" };

  // Handle is opt-in: absent/null = keep the stored one (create generates its
  // own). When present it is a deliberate edit, so a malformed value is a 422 —
  // never silently dropped like the free-text fields below.
  let handle: string | undefined;
  if (r.handle !== undefined && r.handle !== null) {
    if (typeof r.handle !== "string") return { ok: false, code: "invalid_handle" };
    handle = r.handle.trim().toLowerCase();
    if (handle.length > PRODUCT_HANDLE_MAX || !PRODUCT_HANDLE_RE.test(handle)) {
      return { ok: false, code: "invalid_handle" };
    }
  }

  // Search-listing override, also opt-in. Non-string fields are a crafted body
  // (422 invalid_seo); values are trimmed and clamped, and empties are kept —
  // "both empty" is the route's cue to delete the stored override.
  let seo: { metaTitle: string; metaDescription: string } | undefined;
  if (r.seo !== undefined && r.seo !== null) {
    if (typeof r.seo !== "object" || Array.isArray(r.seo)) return { ok: false, code: "invalid_seo" };
    const s = r.seo as Record<string, unknown>;
    for (const field of [s.metaTitle, s.metaDescription]) {
      if (field !== undefined && field !== null && typeof field !== "string") {
        return { ok: false, code: "invalid_seo" };
      }
    }
    // Hard caps behind the editor's 60/160 soft limits; the server accepts a
    // little slack. Clamped by code point so an emoji at the boundary survives.
    seo = {
      metaTitle: clampCodePoints((typeof s.metaTitle === "string" ? s.metaTitle : "").trim(), SEO_TITLE_MAX),
      metaDescription: clampCodePoints((typeof s.metaDescription === "string" ? s.metaDescription : "").trim(), SEO_DESCRIPTION_MAX),
    };
  }

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
      compareAtPriceCents: Number.isFinite(o.compareAtPriceCents) ? Number(o.compareAtPriceCents) : undefined,
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
    if (v.compareAtPriceCents != null && v.compareAtPriceCents < 0) return { ok: false, code: "negative_compare_at" };
    if (v.unitCostCents != null && v.unitCostCents < 0) return { ok: false, code: "negative_cost" };
    // An ACTIVE variant that carries an explicit price must be sellable above $0.
    // The storefront treats only a NULL price as "unpriced/unavailable", so a 0
    // would be sold for free; drafts may still hold a 0 while in progress.
    if (status === "active" && v.retailPriceCents != null && v.retailPriceCents <= 0) return { ok: false, code: "zero_price" };
    // Reject values that would overflow the int4 columns before the INSERT does.
    if (
      (v.retailPriceCents != null && v.retailPriceCents > INT4_MAX) ||
      (v.compareAtPriceCents != null && v.compareAtPriceCents > INT4_MAX) ||
      (v.unitCostCents != null && v.unitCostCents > INT4_MAX) ||
      (v.inventoryOnHand != null && v.inventoryOnHand > INT4_MAX)
    ) {
      return { ok: false, code: "value_too_large" };
    }
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
      handle,
      seo,
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
