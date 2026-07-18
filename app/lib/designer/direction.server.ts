// Art directions for the designer's first build. A store is assigned one
// deliberately — seeded by shop id — so two similar merchants land on
// different, committed looks instead of converging on the same defaults.
// Fonts reference the self-hosted files under /storefront-fonts.
import type { DesignerStoreData } from "./types";

export interface ArtDirection {
  id: string;
  /** Font ids matching public/storefront-fonts/<id>-latin.woff2. */
  displayFont: string;
  bodyFont: string;
  /** Palette described as guidance, not hex law — the model adapts shades. */
  palette: string;
  layout: string;
  mood: string;
}

/** Every font id that exists as a self-hosted woff2 the documents may use. */
export const DESIGNER_FONT_IDS = [
  "archivo-narrow",
  "atkinson-hyperlegible",
  "fraunces",
  "ibm-plex-mono",
  "inter",
  "jetbrains-mono",
  "roboto-slab",
  "source-serif-4",
  "space-grotesk",
] as const;

export const ART_DIRECTIONS: ArtDirection[] = [
  {
    id: "modern-grotesk",
    displayFont: "space-grotesk",
    bodyFont: "inter",
    palette: "cobalt blue accent on warm cream, near-black ink — one saturated pop, everything else quiet",
    layout: "split hero (copy left, image right), airy sections with strong left alignment",
    mood: "confident contemporary brand, generous whitespace",
  },
  {
    id: "mono-pop",
    displayFont: "space-grotesk",
    bodyFont: "atkinson-hyperlegible",
    palette: "off-black and off-white monochrome with a single electric accent (emerald or hot coral)",
    layout: "full-bleed hero with oversized type, tight banded sections with hairline rules",
    mood: "sharp, editorial, high contrast",
  },
  {
    id: "black-and-tan",
    displayFont: "roboto-slab",
    bodyFont: "inter",
    palette: "true off-black with warm tan and bone, no beige mush — hard contrast",
    layout: "stacked bands alternating dark/light, slab headlines, boxed product cards",
    mood: "rugged workshop, heavyweight",
  },
  {
    id: "editorial-forest",
    displayFont: "source-serif-4",
    bodyFont: "inter",
    palette: "deep forest green, bone, and a small amber accent",
    layout: "magazine grid: asymmetric hero, 3-column catalog, pull-quote style section headings",
    mood: "considered outdoors editorial",
  },
  {
    id: "condensed-sport",
    displayFont: "archivo-narrow",
    bodyFont: "atkinson-hyperlegible",
    palette: "terracotta rust against cool slate greys, white ground",
    layout: "dense condensed-type headlines, diagonal energy, edge-to-edge product strips",
    mood: "kinetic, athletic, fast",
  },
  {
    id: "cold-luxury",
    displayFont: "atkinson-hyperlegible",
    bodyFont: "atkinson-hyperlegible",
    palette: "silver-grey, chrome, smoke — near-monochrome cool neutrals, one graphite accent",
    layout: "centered minimal hero, huge negative space, thin rules, small caps labels",
    mood: "precise, expensive, quiet",
  },
  {
    id: "heritage-press",
    displayFont: "fraunces",
    bodyFont: "inter",
    palette: "muted olive, brick red accent, unbleached paper",
    layout: "classic print grid, serif display over two-column body, framed imagery",
    mood: "heritage craft with modern restraint (serif is deliberate here, not a default)",
  },
  {
    id: "utility-tech",
    displayFont: "space-grotesk",
    bodyFont: "ibm-plex-mono",
    palette: "carbon dark ground, signal orange accent, desaturated sage support",
    layout: "spec-sheet aesthetic: mono labels, gridded cards with index numbers, sticky utility bar",
    mood: "technical field equipment, purposeful",
  },
];

/** Stable per-shop assignment. Merchants can always steer away in chat; this
 *  only decides where the first build starts. */
export function artDirectionFor(shopId: string): ArtDirection {
  let hash = 0;
  for (let i = 0; i < shopId.length; i += 1) hash = (hash * 31 + shopId.charCodeAt(i)) >>> 0;
  return ART_DIRECTIONS[hash % ART_DIRECTIONS.length];
}

const FONT_FACE = (id: string) =>
  `@font-face{font-family:"${id}";src:url(/storefront-fonts/${id}-latin.woff2);font-display:swap;font-weight:100 900}`;

/** Seed documents for a from-scratch build: a base.css scaffold carrying the
 *  direction's fonts plus minimal valid pages the model rewrites whole-file. */
export function scratchSeedFiles(direction: ArtDirection, data: DesignerStoreData): Record<string, string> {
  const baseCss = [
    FONT_FACE(direction.displayFont),
    ...(direction.bodyFont !== direction.displayFont ? [FONT_FACE(direction.bodyFont)] : []),
    `:root{--font-display:"${direction.displayFont}",sans-serif;--font-body:"${direction.bodyFont}",sans-serif}`,
    "*,*::before,*::after{box-sizing:border-box}body{margin:0;font-family:var(--font-body)}img{max-width:100%;display:block}",
    ".designer-add-to-cart{padding:10px 18px;border:1px solid currentColor;background:transparent;color:inherit;font:inherit;cursor:pointer}",
  ].join("\n");

  const skeleton = (route: string, body: string) =>
    `<header><a href="/storefront">{{store.name}}</a></header>\n<main data-designer-route="${route}">\n${body}\n</main>\n<footer><span>{{store.name}}</span></footer>`;

  return {
    "base.css": baseCss,
    "home.html": skeleton("home", `<h1>{{store.name}}</h1><p>{{store.tagline}}</p>\n{{#products}}<article><a href="{{product.url}}"><img src="{{product.image}}" alt="{{product.title}}"><h3>{{product.title}}</h3><span>{{product.price}}</span></a></article>{{/products}}`),
    "home.css": "",
    "collection.html": skeleton("collection", `<h1>{{collection.title}}</h1>\n{{#products}}<article><a href="{{product.url}}"><img src="{{product.image}}" alt="{{product.title}}"><h3>{{product.title}}</h3><span>{{product.price}}</span></a></article>{{/products}}`),
    "collection.css": "",
    "product.html": skeleton("product", `<img src="{{product.image}}" alt="{{product.title}}">\n<h1>{{product.title}}</h1><p>{{product.price}}</p><p>{{product.availability}}</p>\n<button class="designer-add-to-cart" type="button">Add to cart</button>`),
    "product.css": "",
    "search.html": skeleton("search", `<h1>Search</h1>\n{{#products}}<article><a href="{{product.url}}"><h3>{{product.title}}</h3><span>{{product.price}}</span></a></article>{{/products}}`),
    "search.css": "",
    "cart.html": skeleton("cart", `<h1>Your cart</h1><p>Basket: {{cart.count}}</p><a href="/storefront/checkout">Checkout</a>`),
    "cart.css": "",
    "checkout.html": skeleton("checkout", `<h1>Checkout</h1><p>Order summary for {{store.name}}</p><a href="/storefront/cart">Back to cart</a>`),
    "checkout.css": "",
  };
}
