// app/lib/storegen/fallback.ts
// The deterministic source of truth when Claude errors / times out / returns junk / blows the
// token budget — composed from catalog facts + block defaults, ALWAYS publishable (rule 12).
// Used per-doc, so a failed PDP plan never loses a good home doc.
import type { BlockDocument, PageKey } from "~/lib/storebuilder/types";

export interface BrandFacts { storeName: string; tagline: string }

export function fallbackDoc(pageKey: PageKey, brand: BrandFacts): BlockDocument {
  if (pageKey === "collection") {
    return { kind: "template", pageKey, blocks: [
      { id: "fb-coll-grid", type: "collectionGrid", layout: { x: 0, y: 0, w: 12, h: 6 }, props: {} },
    ] };
  }
  if (pageKey === "pdp") {
    return { kind: "template", pageKey, blocks: [
      { id: "fb-gallery", type: "productGallery", layout: { x: 0, y: 0, w: 6, h: 6 }, props: { maxImages: 6 } },
      { id: "fb-price", type: "price", layout: { x: 6, y: 0, w: 6, h: 1 }, props: {} },
      { id: "fb-variant", type: "variantPicker", layout: { x: 6, y: 1, w: 6, h: 2 }, props: {} },
      { id: "fb-atc", type: "addToCart", layout: { x: 6, y: 3, w: 6, h: 1 }, props: {} },
    ] };
  }
  // home (singleton): hero + all-products grid — references no specific catalog id, never blanks.
  return { kind: "singleton", pageKey: "home", blocks: [
    { id: "fb-hero", type: "hero", layout: { x: 0, y: 0, w: 12, h: 2 }, props: { headline: brand.storeName || "Welcome", subhead: brand.tagline || "Shop our latest" } },
    { id: "fb-grid", type: "productGrid", layout: { x: 0, y: 2, w: 12, h: 6 }, props: { source: { kind: "all" }, heading: "Shop all" } },
  ] };
}
