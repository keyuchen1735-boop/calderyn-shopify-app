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
  // Product-independent value props — the backbone of the no-catalog "hollow" store.
  featuresHeading: string;
  features: { title: string; body: string }[];
}

// Two voices per vibe: distinct sentence shape and word choice, not just a palette swap, so the
// no-credits path still reads like different designers rather than one template. Variant 0 is the
// original copy; variant 1 is a second register in the same vibe. Which one a store gets is keyed
// off its name (see voiceVariantIndex), so two shops with the same vibe read differently while a
// regenerate never flips an individual shop's copy.
const VOICES: Record<StudioVibe, readonly Voice[]> = {
  minimal: [{
    heroHeadline: (noun, storeName) => (noun ? `${cap(noun)}, considered` : storeName || "Considered essentials"),
    heroSubhead: (noun) => (noun ? `Fewer, better things, starting with ${low(noun)}.` : "Fewer, better things."),
    gridHeading: (noun) => (noun ? `Start with ${noun}` : "Shop the edit"),
    story: (noun, storeName) =>
      `${storeName || "This shop"} keeps a tight catalog on purpose: every piece earns its place before it ships${noun ? `, starting with ${low(noun)}` : ""}. Fewer options, chosen with more care.`,
    ctaLabel: "Shop the edit",
    closingLabel: "See everything",
    featuresHeading: "Why it's different",
    features: [
      { title: "Considered by design", body: "Every detail is deliberate. Nothing here is filler." },
      { title: "Made to last", body: "Chosen materials, built to outlive the trend cycle." },
      { title: "Quietly guaranteed", body: "Thirty days to change your mind — no fuss." },
    ],
  },
  {
    heroHeadline: (noun, storeName) => (noun ? `${cap(noun)}, pared back to the good part` : storeName || "Pared back to the good part"),
    heroSubhead: (noun) => (noun ? `A short list built around ${low(noun)}, nothing extra.` : "A short list, nothing extra."),
    gridHeading: (noun) => (noun ? `The ${noun} shortlist` : "The shortlist"),
    story: (noun, storeName) =>
      `${storeName || "This shop"} would rather stock ten things worth owning than a hundred that fill a page. ${noun ? `${cap(noun)} is where that standard starts.` : "That standard shapes everything here."}`,
    ctaLabel: "See the shortlist",
    closingLabel: "Browse the full list",
    featuresHeading: "What we optimize for",
    features: [
      { title: "Fewer, better", body: "A small catalog means every item gets real attention." },
      { title: "Chosen twice", body: "Everything is used at home before it goes on sale." },
      { title: "Easy returns", body: "Thirty days, no forms, no questions." },
    ],
  }],
  bold: [{
    heroHeadline: (noun, storeName) => (noun ? `${cap(noun)}. No compromises.` : storeName || "No compromises."),
    heroSubhead: (noun) => (noun ? `Built around ${low(noun)}. Engineered, not decorated.` : "Engineered, not decorated."),
    gridHeading: (noun) => (noun ? `The ${noun} lineup` : "The full lineup"),
    story: (noun, storeName) =>
      `${storeName || "This shop"} does not chase trends.${noun ? ` ${cap(noun)} is built to outlast the season it shipped in.` : " Every piece is built to outlast the season it shipped in."}`,
    ctaLabel: "Shop now",
    closingLabel: "View the full range",
    featuresHeading: "Built different",
    features: [
      { title: "Engineered, not decorated", body: "Function first. Every choice earns its place." },
      { title: "Zero compromise", body: "We don't cut the corners you can't see." },
      { title: "Backed hard", body: "If it fails, we make it right. Simple." },
    ],
  },
  {
    heroHeadline: (noun, storeName) => (noun ? `${cap(noun)} that earns its keep` : storeName || "Gear that earns its keep"),
    heroSubhead: (noun) => (noun ? `${cap(noun)} tested hard before it gets the label.` : "Tested hard before it gets the label."),
    gridHeading: (noun) => (noun ? `${noun}, proven` : "Proven picks"),
    story: (noun, storeName) =>
      `${storeName || "This shop"} publishes the test results, not the mood board.${noun ? ` ${cap(noun)} ships because it survived; nothing here is decoration.` : " Everything ships because it survived; nothing here is decoration."}`,
    ctaLabel: "Shop what lasts",
    closingLabel: "See everything we make",
    featuresHeading: "Held to a standard",
    features: [
      { title: "Tested, then shipped", body: "Prototypes get broken so your order doesn't." },
      { title: "Spec over styling", body: "Materials chosen for load, wear, and weather." },
      { title: "Fixed or replaced", body: "If it breaks in normal use, we sort it. Done." },
    ],
  }],
  warm: [{
    heroHeadline: (noun, storeName) => (noun ? `A little more ${low(noun)} in your day` : storeName || "Made for slow mornings"),
    heroSubhead: (noun) => (noun ? `Small-batch ${low(noun)}, made the unhurried way.` : "Small batches, made the unhurried way."),
    gridHeading: (noun) => (noun ? `Our favorite ${noun}` : "Our favorites"),
    story: (noun, storeName) =>
      `Every ${noun ? low(noun) : "item"} at ${storeName || "this shop"} is made in small batches, by hand, with time to get it right. Nothing rushed, nothing mass-produced.`,
    ctaLabel: "Shop the collection",
    closingLabel: "Browse everything",
    featuresHeading: "Made with care",
    features: [
      { title: "Small batches", body: "Made by hand, in numbers small enough to get right." },
      { title: "Honest materials", body: "Natural, traceable, and kinder to the planet." },
      { title: "Sent like a gift", body: "Wrapped with care, because it should feel special." },
    ],
  },
  {
    heroHeadline: (noun, storeName) => (noun ? `${cap(noun)} worth slowing down for` : storeName || "Worth slowing down for"),
    heroSubhead: (noun) => (noun ? `${cap(noun)} made in small rounds and finished by hand.` : "Made in small rounds and finished by hand."),
    gridHeading: (noun) => (noun ? `${noun} we reach for first` : "What we reach for first"),
    story: (noun, storeName) =>
      `At ${storeName || "our shop"}, ${noun ? low(noun) : "each batch"} gets finished, checked, and wrapped by the same pair of hands. If we wouldn't keep it, we don't send it.`,
    ctaLabel: "Have a look around",
    closingLabel: "See the whole shelf",
    featuresHeading: "The way we work",
    features: [
      { title: "Made in small rounds", body: "Never more at once than we can finish properly." },
      { title: "Materials we can name", body: "We know where every component comes from." },
      { title: "Packed to arrive well", body: "Wrapped so the unboxing feels like the gift." },
    ],
  }],
};

function hashString(s: string): number {
  // djb2-xor: tiny, dependency-free, and stable across runs/platforms — all this needs.
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return h >>> 0;
}

/** Which voice variant a store gets, keyed off its name: stable per shop (a regenerate never
 *  flips the copy) while two different shops with the same vibe read differently. Exported so
 *  tests can pick names on known variants. */
export function voiceVariantIndex(storeName: string): number {
  return hashString(storeName.trim().toLowerCase()) % VOICES.minimal.length;
}

function voiceFor(vibe: StudioVibe, storeName: string): Voice {
  const variants = VOICES[vibe];
  return variants[voiceVariantIndex(storeName) % variants.length];
}

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
  // No catalog to draw on (empty catalog, or no context at all). Rather than a bare hero over an
  // empty product grid, compose a complete brand story that stands on its own: a gradient hero (no
  // image needed), a CTA, a value-prop row, an editorial line and a closing CTA — a "hollow" but
  // genuinely designed store, in the vibe's voice, that never reads as broken or unfinished.
  if (products.length === 0 && collections.length === 0) {
    const vibe: StudioVibe = context?.vibe ?? "minimal";
    const voice = voiceFor(vibe, brand.storeName);
    return { kind: "singleton", pageKey: "home", blocks: [
      { id: "fb-hero", type: "hero", layout: { x: 0, y: 0, w: 12, h: 3 }, props: { headline: clip(voice.heroHeadline(null, brand.storeName), HEADLINE_MAX), subhead: clip(brand.tagline || voice.heroSubhead(null), SUBHEAD_MAX) } },
      { id: "fb-cta", type: "button", layout: { x: 0, y: 3, w: 3, h: 1 }, props: { label: clip(voice.ctaLabel, LABEL_MAX), href: "/storefront" } },
      { id: "fb-features", type: "featureRow", layout: { x: 0, y: 4, w: 12, h: 3 }, props: { heading: voice.featuresHeading, items: voice.features } },
      { id: "fb-story", type: "richText", layout: { x: 0, y: 7, w: 12, h: 2 }, props: { html: clip(voice.story(null, brand.storeName), HTML_MAX) } },
      { id: "fb-cta-2", type: "button", layout: { x: 0, y: 9, w: 3, h: 1 }, props: { label: clip(voice.closingLabel, LABEL_MAX), href: "/storefront" } },
    ] };
  }

  const vibe: StudioVibe = context?.vibe ?? "minimal";
  const voice = voiceFor(vibe, brand.storeName);
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
