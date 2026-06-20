// Shared SKU title helpers used by BOTH surfaces (embedded app + dashboard) so
// product/variant naming reads identically everywhere.
//
// Stored titles use the form "<product> — <variant>" (see ingest
// `mapVariantToSku`). Shopify variant options frequently repeat the product name
// inside the option value ("Sample Selling Plans Ski Wax"), which would render as
// "Selling Plans Ski Wax — Sample Selling Plans Ski Wax". These helpers strip
// that repetition and expose the parts so the UI can lead with the variant.
//
// Pure + isomorphic (no server-only deps) on purpose: the ingest mapper builds
// the stored title with `buildSkuTitle`, and the client splits it back with
// `splitSkuTitle`, keeping both sides in lockstep.

export const SKU_TITLE_SEP = " — ";

export type SkuTitleParts = { product: string; variant: string | null };

// Reduce a variant option to just its distinguishing part: strip any repeated
// product name and collapse whitespace. Returns null when nothing meaningful
// remains — i.e. the option IS the product name, it's Shopify's "Default Title",
// or it's blank — so single-variant products show the product name alone.
export function cleanVariantTitle(
  productTitle: string,
  variantTitle: string | null | undefined,
): string | null {
  const v = (variantTitle ?? "").trim();
  if (!v || v === "Default Title") return null;
  const product = productTitle.trim();
  // String split (not regex) → product names with special chars are safe.
  const stripped = product ? v.split(product).join(" ").replace(/\s+/g, " ").trim() : v;
  return stripped.length ? stripped : null;
}

// Build the stored "<product> — <variant>" title (variant deduped). Falls back
// to the product name alone when there is no distinguishing variant.
export function buildSkuTitle(
  productTitle: string,
  variantTitle: string | null | undefined,
): string {
  const variant = cleanVariantTitle(productTitle, variantTitle);
  return variant ? `${productTitle}${SKU_TITLE_SEP}${variant}` : productTitle;
}

// Split a stored title back into { product, variant } for variant-first display.
// Robust to legacy rows where the variant still repeats the product name (the
// dedupe runs again here), so it is correct before any re-ingest.
export function splitSkuTitle(title: string): SkuTitleParts {
  const raw = (title ?? "").trim();
  const idx = raw.indexOf(SKU_TITLE_SEP);
  if (idx === -1) return { product: raw, variant: null };
  const product = raw.slice(0, idx).trim();
  const variant = cleanVariantTitle(product, raw.slice(idx + SKU_TITLE_SEP.length));
  return { product, variant };
}
