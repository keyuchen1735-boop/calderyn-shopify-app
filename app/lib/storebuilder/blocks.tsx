// app/lib/storebuilder/blocks.tsx
// The 6 starter blocks. Each is a self-contained BlockMeta: validator + refs + component.
// ponytail: hand-rolled validators (repo has no Zod) matching the boundary-validation style
// in app/lib/buyer/identity.server.ts. Validators are tolerant — fill defaults, coerce — and
// throw only on irrecoverable shape (renderBlocks/validateDocument catch and skip).
import { createElement, useEffect, useRef } from "react";
import type { BlockMeta, RenderContext } from "./types";
import { STOREFRONT_LINKS } from "./links";
import { hydrateStoreFx } from "./fx/hydrate";
import type { StoreProduct } from "~/lib/storefront/catalog";
import { formatMoney } from "~/lib/storefront/money";
import { productCardMedia } from "./product-card";

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const safeHref = (v: unknown, fallback: string): string => {
  const s = str(v, fallback);
  // ponytail: allowlist absolute http(s) + root-relative only; anything else (javascript:,
  // data:, etc.) falls back. AI/merchant-supplied hrefs are an untrusted XSS vector.
  return /^(https?:\/\/|\/)/.test(s) ? s : fallback;
};
// Same allowlist for an <img src>: AI/merchant-supplied URLs are untrusted. Reject javascript:,
// data:, and other schemes; an empty result renders no image rather than an unsafe src.
const safeImageSrc = (v: unknown): string => {
  const s = str(v, "");
  return /^(https?:\/\/|\/)/.test(s) ? s : "";
};

function money(p: StoreProduct): string {
  const v = p.variants[0];
  if (!v) return "";
  return formatMoney(v.priceCents, v.currency);
}

// ── static ────────────────────────────────────────────────────────────────
interface HeroProps { headline: string; subhead: string; imageUrl: string }
const hero: BlockMeta<HeroProps> = {
  type: "hero", flavor: "static", allowedDocKinds: ["singleton", "template"],
  defaultProps: { headline: "Welcome", subhead: "Shop our latest", imageUrl: "" },
  defaultLayout: { x: 0, y: 0, w: 12, h: 2 },
  // imageUrl is optional: an empty/unsafe src renders the classic text hero, a safe one turns it
  // into a full-bleed image hero (see [data-has-image] in storefront.css). Same src allowlist as
  // the image block — AI/merchant URLs are untrusted.
  validateProps: (raw) => { const r = asRecord(raw); return { headline: str(r.headline, "Welcome"), subhead: str(r.subhead, "Shop our latest"), imageUrl: safeImageSrc(r.imageUrl) }; },
  catalogRefs: () => ({ productIds: [], collectionHandles: [] }),
  // A real <img> behind the copy (not a CSS background) keeps the same safe-src allowlist and lets
  // the browser lazy-load it; the scrim + white text live in storefront.css under [data-has-image].
  Component: ({ props }) =>
    createElement("section", { className: "cd-block cd-block--hero", ...(props.imageUrl ? { "data-has-image": "1" } : {}) },
      props.imageUrl ? createElement("img", { className: "cd-hero__bg", src: props.imageUrl, alt: "", "aria-hidden": "true", loading: "lazy" }) : null,
      createElement("h1", { className: "cd-hero__headline" }, props.headline),
      createElement("p", { className: "cd-hero__subhead" }, props.subhead)),
};

interface RichTextProps { text: string }
const richText: BlockMeta<RichTextProps> = {
  type: "richText", flavor: "static", allowedDocKinds: ["singleton", "template"],
  defaultProps: { text: "Tell your story." },
  defaultLayout: { x: 0, y: 0, w: 12, h: 2 },
  // The generator contract emits richText copy under `html` (a plain-text string, bounded by
  // COPY_BOUNDS); accept `html` first, falling back to `text`, so AI/merchant copy is not
  // silently dropped to an empty block.
  validateProps: (raw) => { const r = asRecord(raw); return { text: str(r.html, str(r.text, "")) }; },
  catalogRefs: () => ({ productIds: [], collectionHandles: [] }),
  // ponytail: plain text only — NOT dangerouslySetInnerHTML. Rich formatting is the editor's
  // job later via a sanitized prop; rendering merchant/AI HTML raw would be an XSS sink.
  Component: ({ props }) => createElement("div", { className: "cd-block cd-block--text" }, props.text),
};

interface ImageProps { url: string; alt: string }
const image: BlockMeta<ImageProps> = {
  type: "image", flavor: "static", allowedDocKinds: ["singleton", "template"],
  defaultProps: { url: "", alt: "" },
  defaultLayout: { x: 0, y: 0, w: 6, h: 4 },
  validateProps: (raw) => { const r = asRecord(raw); return { url: safeImageSrc(r.url), alt: str(r.alt) }; },
  catalogRefs: () => ({ productIds: [], collectionHandles: [] }),
  Component: ({ props }) =>
    props.url ? createElement("img", { className: "cd-block cd-block--image", src: props.url, alt: props.alt }) : null,
};

interface ButtonProps { label: string; href: string }
const button: BlockMeta<ButtonProps> = {
  type: "button", flavor: "static", allowedDocKinds: ["singleton", "template"],
  defaultProps: { label: "Shop now", href: "/storefront" },
  defaultLayout: { x: 0, y: 0, w: 3, h: 1 },
  validateProps: (raw) => { const r = asRecord(raw); return { label: str(r.label, "Shop now"), href: safeHref(r.href, "/storefront") }; },
  catalogRefs: () => ({ productIds: [], collectionHandles: [] }),
  Component: ({ props, ctx }) =>
    createElement("a", { className: "cd-block cd-block--button", href: (ctx.links ?? STOREFRONT_LINKS).href(props.href) }, props.label),
};

interface FeatureItem { title: string; body: string }
interface FeatureRowProps { heading: string; items: FeatureItem[] }
// A product-independent value-prop row (up to 4 cards). Central to the "hollow" store: it fills a
// no-catalog home with real structure instead of an empty product grid. Renders nothing when it
// has no items, so a malformed/empty block never leaves a bare heading behind.
const featureRow: BlockMeta<FeatureRowProps> = {
  type: "featureRow", flavor: "static", allowedDocKinds: ["singleton", "template"],
  defaultProps: { heading: "", items: [] },
  defaultLayout: { x: 0, y: 0, w: 12, h: 3 },
  validateProps: (raw) => {
    const r = asRecord(raw);
    const items = (Array.isArray(r.items) ? r.items : [])
      .slice(0, 4)
      .map((it) => { const o = asRecord(it); return { title: str(o.title).slice(0, 60), body: str(o.body, str(o.text)).slice(0, 180) }; })
      .filter((it) => it.title || it.body);
    return { heading: str(r.heading).slice(0, 80), items };
  },
  catalogRefs: () => ({ productIds: [], collectionHandles: [] }),
  Component: ({ props }) =>
    props.items.length === 0
      ? null
      : createElement("section", { className: "cd-block cd-block--features" },
          props.heading ? createElement("h2", { className: "cd-features__heading" }, props.heading) : null,
          createElement("div", { className: "cd-features__grid" },
            props.items.map((it, i) =>
              createElement("div", { key: i, className: "cd-feature" },
                createElement("span", { className: "cd-feature__rule", "aria-hidden": "true" }),
                it.title ? createElement("h3", { className: "cd-feature__title" }, it.title) : null,
                it.body ? createElement("p", { className: "cd-feature__body" }, it.body) : null)))),
};

interface RawHtmlProps { html: string }
// A complete, pre-sanitized HTML home authored by the generator's AI-HTML path — the escape hatch
// from the fixed block vocabulary, so a store can look fully designed (gradients, big type, sections,
// inline SVG) WITHOUT depending on product imagery. SECURITY: props.html is sanitized server-side at
// the persistence boundary (saveDraft → sanitizeStoreHtml); this block renders it verbatim and must
// NEVER be handed un-sanitized html. validateProps stays a cheap string/length coerce so no
// sanitizer is pulled into the client bundle.
// Mounts the sanitized markup, then hydrates its data-fx-shader / data-fx-motion
// effect channels client-side (the effect is a no-op on the server and skips when
// html is empty). Re-keyed on props.html so a regenerated home tears down the old
// effects before hydrating the new markup.
function RawHtmlBlock({ props }: { props: RawHtmlProps; ctx: RenderContext }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return hydrateStoreFx(el);
  }, [props.html]);
  if (!props.html) return null;
  return createElement("div", {
    ref,
    className: "cd-block cd-block--rawhtml",
    dangerouslySetInnerHTML: { __html: props.html },
  });
}
const rawHtml: BlockMeta<RawHtmlProps> = {
  type: "rawHtml", flavor: "static", allowedDocKinds: ["singleton", "template"],
  defaultProps: { html: "" },
  defaultLayout: { x: 0, y: 0, w: 12, h: 12 },
  validateProps: (raw) => ({ html: str(asRecord(raw).html).slice(0, 100000) }),
  catalogRefs: () => ({ productIds: [], collectionHandles: [] }),
  Component: RawHtmlBlock,
};

// ── dynamic ───────────────────────────────────────────────────────────────
type GridSource = { kind: "all" } | { kind: "collection"; handle: string } | { kind: "ids"; ids: string[] };
interface ProductGridProps { source: GridSource; heading: string }
function gridProducts(source: GridSource, ctx: RenderContext): StoreProduct[] {
  if (source.kind === "all") return ctx.data.allProducts;
  if (source.kind === "collection") return ctx.data.productsByCollection[source.handle] ?? [];
  return source.ids.map((id) => ctx.data.productsById[id]).filter((p): p is StoreProduct => Boolean(p));
}
const productGrid: BlockMeta<ProductGridProps> = {
  type: "productGrid", flavor: "dynamic", allowedDocKinds: ["singleton", "template"],
  defaultProps: { source: { kind: "all" }, heading: "Products" },
  defaultLayout: { x: 0, y: 2, w: 12, h: 6 },
  validateProps: (raw) => {
    const r = asRecord(raw); const s = asRecord(r.source);
    let source: GridSource = { kind: "all" };
    if (s.kind === "collection" && typeof s.handle === "string") source = { kind: "collection", handle: s.handle };
    else if (s.kind === "ids" && Array.isArray(s.ids)) source = { kind: "ids", ids: s.ids.filter((x): x is string => typeof x === "string") };
    return { source, heading: str(r.heading, "Products") };
  },
  catalogRefs: (props) => ({
    productIds: props.source.kind === "ids" ? props.source.ids : [],
    collectionHandles: props.source.kind === "collection" ? [props.source.handle] : [],
  }),
  Component: ({ props, ctx }) => {
    const links = ctx.links ?? STOREFRONT_LINKS;
    return createElement("section", { className: "cd-block cd-block--grid" },
      props.heading ? createElement("h2", { className: "cd-grid__heading" }, props.heading) : null,
      createElement("div", { className: "cd-store__grid" },
        gridProducts(props.source, ctx).map((p) =>
          createElement("a", { key: p.id, className: "cd-product-card", href: links.product(p.handle) },
            productCardMedia(p),
            createElement("span", { className: "cd-product-card__title" }, p.title),
            createElement("span", { className: "cd-product-card__price" }, money(p)))))); },
};

interface CollectionListProps { heading: string }
const collectionList: BlockMeta<CollectionListProps> = {
  type: "collectionList", flavor: "dynamic", allowedDocKinds: ["singleton"],
  defaultProps: { heading: "Collections" },
  defaultLayout: { x: 0, y: 0, w: 12, h: 1 },
  validateProps: (raw) => ({ heading: str(asRecord(raw).heading, "Collections") }),
  // catalogRefs is empty: collectionList needs the FULL collection list, which CatalogRefs
  // (productIds/collectionHandles) can't express. resolve-data (a later task) pre-fetches all
  // collections by keying off this block's `type`. ponytail: block-type special-case in the
  // resolver instead of adding a new contract sentinel.
  catalogRefs: () => ({ productIds: [], collectionHandles: [] }),
  Component: ({ props, ctx }) =>
    createElement("nav", { className: "cd-block cd-block--collections" },
      props.heading ? createElement("h2", { className: "cd-collections__heading" }, props.heading) : null,
      createElement("div", { className: "cd-collections__cards" },
        ctx.data.collections.map((c) => {
          const count = ctx.data.productsByCollection[c.handle]?.length;
          return createElement("a", { key: c.handle, className: "cd-collection-card", href: (ctx.links ?? STOREFRONT_LINKS).collection(c.handle) },
            createElement("span", { className: "cd-collection-card__title" }, c.title),
            // Count only when this page's data actually loaded the collection's
            // products — an absent entry means unknown, not zero.
            count !== undefined ? createElement("span", { className: "cd-collection-card__count" }, `${count} item${count === 1 ? "" : "s"}`) : null,
            createElement("span", { className: "cd-collection-card__arrow", "aria-hidden": true }, "→"));
        }))),
};

// Exported as a plain array; the registry indexes it by type (Task 3).
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous BlockMeta<P> union; registry narrows by type
export const STARTER_BLOCKS: BlockMeta<any>[] = [hero, richText, image, button, featureRow, rawHtml, productGrid, collectionList];
