// app/lib/storegen/fallback.ts
// The deterministic source of truth when Claude errors / times out / returns junk / blows the
// token budget — composed from catalog facts + block defaults, ALWAYS publishable (rule 12).
// Used per-doc, so a failed PDP plan never loses a good home doc. This is also the ship-today
// experience while ANTHROPIC_API_KEY is at its limit, so the home composition below is
// deliberately designed rather than a placeholder: per-vibe copy voices templated over the real
// catalog nouns (product/collection titles), never invented ones.
import type { Block, BlockDocument, PageKey } from "~/lib/storebuilder/types";
import type { StudioVibe } from "~/lib/storebuilder/studio-types";

export interface BrandFacts { storeName: string; tagline: string }

/** Real catalog facts to template deterministic copy from. Optional: omitting it (or passing an
 *  empty catalog) keeps the original universal fallback — hero + all-products grid, referencing
 *  no specific catalog id, so an empty-catalog run never blanks and never invents a ref. */
export interface FallbackContext {
  products?: { title: string; imageUrl?: string }[];
  collections?: { handle: string; title: string }[];
  vibe?: StudioVibe;
}

// Fallback docs are saved straight to page_document without passing through assembleDocument
// (see generate.server.ts), so they must self-enforce the same length limits that pass would
// have applied. Mirrors the generator's COPY_BOUNDS (storegen/sanitize.ts).
const HEADLINE_MAX = 120;
const SUBHEAD_MAX = 200;
const HEADING_MAX = 80;
const LABEL_MAX = 40;
const HTML_MAX = 2000;

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}
const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const low = (s: string): string => s.toLowerCase();

interface Voice {
  heroHeadline(noun: string | null, storeName: string): string;
  heroSubhead(noun: string | null): string;
  gridHeading(noun: string | null): string;
  story(noun: string | null, storeName: string): string;
  ctaLabel: string;
  closingLabel: string;
}

// One voice per vibe: distinct sentence shape and word choice, not just a palette swap, so the
// no-credits path still reads like three different designers rather than one template.
const VOICE: Record<StudioVibe, Voice> = {
  minimal: {
    heroHeadline: (noun, storeName) => (noun ? `${cap(noun)}, considered` : storeName || "Considered essentials"),
    heroSubhead: (noun) => (noun ? `Fewer, better things, starting with ${low(noun)}.` : "Fewer, better things."),
    gridHeading: (noun) => (noun ? `Start with ${noun}` : "Shop the edit"),
    story: (noun, storeName) =>
      `${storeName || "This shop"} keeps a tight catalog on purpose: every piece earns its place before it ships${noun ? `, starting with ${low(noun)}` : ""}. Fewer options, chosen with more care.`,
    ctaLabel: "Shop the edit",
    closingLabel: "See everything",
  },
  bold: {
    heroHeadline: (noun, storeName) => (noun ? `${cap(noun)}. No compromises.` : storeName || "No compromises."),
    heroSubhead: (noun) => (noun ? `Built around ${low(noun)}. Engineered, not decorated.` : "Engineered, not decorated."),
    gridHeading: (noun) => (noun ? `The ${noun} lineup` : "The full lineup"),
    story: (noun, storeName) =>
      `${storeName || "This shop"} does not chase trends.${noun ? ` ${cap(noun)} is built to outlast the season it shipped in.` : " Every piece is built to outlast the season it shipped in."}`,
    ctaLabel: "Shop now",
    closingLabel: "View the full range",
  },
  warm: {
    heroHeadline: (noun, storeName) => (noun ? `A little more ${low(noun)} in your day` : storeName || "Made for slow mornings"),
    heroSubhead: (noun) => (noun ? `Small-batch ${low(noun)}, made the unhurried way.` : "Small batches, made the unhurried way."),
    gridHeading: (noun) => (noun ? `Our favorite ${noun}` : "Our favorites"),
    story: (noun, storeName) =>
      `Every ${noun ? low(noun) : "item"} at ${storeName || "this shop"} is made in small batches, by hand, with time to get it right. Nothing rushed, nothing mass-produced.`,
    ctaLabel: "Shop the collection",
    closingLabel: "Browse everything",
  },
};

export function fallbackDoc(pageKey: PageKey, brand: BrandFacts, context?: FallbackContext): BlockDocument {
  if (pageKey === "collection") {
    return { kind: "template", pageKey, blocks: [
      { id: "fb-coll-grid", type: "collectionGrid", layout: { x: 0, y: 0, w: 12, h: 6 }, props: {} },
    ] };
  }
  if (pageKey === "pdp") {
    return { kind: "template", pageKey, blocks: [
      { id: "fb-gallery", type: "productGallery", layout: { x: 0, y: 0, w: 6, h: 6 }, props: { maxImages: 6 } },
      { id: "fb-title", type: "productTitle", layout: { x: 6, y: 0, w: 6, h: 1 }, props: {} },
      { id: "fb-price", type: "price", layout: { x: 6, y: 1, w: 6, h: 1 }, props: {} },
      { id: "fb-variant", type: "variantPicker", layout: { x: 6, y: 2, w: 6, h: 2 }, props: {} },
      { id: "fb-atc", type: "addToCart", layout: { x: 6, y: 4, w: 6, h: 1 }, props: {} },
    ] };
  }

  const products = context?.products ?? [];
  const collections = context?.collections ?? [];
  // No catalog nouns to draw on (empty catalog, or no context passed at all) — the pre-v2
  // universal fallback: hero + all-products grid, referencing no specific catalog id, never blanks.
  if (products.length === 0 && collections.length === 0) {
    return { kind: "singleton", pageKey: "home", blocks: [
      { id: "fb-hero", type: "hero", layout: { x: 0, y: 0, w: 12, h: 2 }, props: { headline: brand.storeName || "Welcome", subhead: brand.tagline || "Shop our latest" } },
      { id: "fb-grid", type: "productGrid", layout: { x: 0, y: 2, w: 12, h: 6 }, props: { source: { kind: "all" }, heading: "Shop all" } },
    ] };
  }

  const vibe: StudioVibe = context?.vibe ?? "minimal";
  const voice = VOICE[vibe];
  const topCollection = collections[0] ?? null;
  const topProduct = products[0] ?? null;
  const noun = (topCollection?.title || topProduct?.title || "").trim() || null;
  // Collection-sourced when the catalog has one — a real handle, never invented (D2/D4).
  const source = topCollection ? { kind: "collection" as const, handle: topCollection.handle } : { kind: "all" as const };
  // The first product with imagery becomes the hero backdrop — deterministic, always renders, and
  // turns the plain text hero into a full-bleed image hero on the no-credits path (empty when none).
  const heroImage = products.find((p) => p.imageUrl)?.imageUrl ?? "";

  const blocks: Block[] = [];
  let y = 0;
  const push = (id: string, type: Block["type"], h: number, w: number, props: Record<string, unknown>) => {
    blocks.push({ id, type, layout: { x: 0, y, w, h }, props });
    y += h;
  };

  push("fb-hero", "hero", 2, 12, {
    headline: clip(voice.heroHeadline(noun, brand.storeName), HEADLINE_MAX),
    subhead: clip(brand.tagline || voice.heroSubhead(noun), SUBHEAD_MAX),
    imageUrl: heroImage,
  });
  push("fb-cta", "button", 1, 3, { label: clip(voice.ctaLabel, LABEL_MAX), href: "/storefront" });
  push("fb-grid", "productGrid", 6, 12, { source, heading: clip(voice.gridHeading(noun), HEADING_MAX) });
  push("fb-story", "richText", 2, 12, { html: clip(voice.story(noun, brand.storeName), HTML_MAX) });
  if (collections.length >= 2) {
    push("fb-collections", "collectionList", 1, 12, { heading: "Shop by collection" });
  }
  push("fb-cta-2", "button", 1, 3, { label: clip(voice.closingLabel, LABEL_MAX), href: "/storefront" });

  return { kind: "singleton", pageKey: "home", blocks };
}
