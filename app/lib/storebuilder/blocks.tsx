// app/lib/storebuilder/blocks.tsx
// The 6 starter blocks. Each is a self-contained BlockMeta: validator + refs + component.
// ponytail: hand-rolled validators (repo has no Zod) matching the boundary-validation style
// in app/lib/buyer/identity.server.ts. Validators are tolerant — fill defaults, coerce — and
// throw only on irrecoverable shape (renderBlocks/validateDocument catch and skip).
import { createElement } from "react";
import type { BlockMeta, CatalogRefs, RenderContext } from "./types";
import type { StoreProduct } from "~/lib/storefront/catalog";

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

function money(p: StoreProduct): string {
  const v = p.variants[0];
  if (!v) return "";
  return new Intl.NumberFormat(undefined, { style: "currency", currency: v.currency }).format(v.priceCents / 100);
}

// ── static ────────────────────────────────────────────────────────────────
interface HeroProps { headline: string; subhead: string }
const hero: BlockMeta<HeroProps> = {
  type: "hero", flavor: "static", allowedDocKinds: ["singleton", "template"],
  defaultProps: { headline: "Welcome", subhead: "Shop our latest" },
  defaultLayout: { x: 0, y: 0, w: 12, h: 2 },
  validateProps: (raw) => { const r = asRecord(raw); return { headline: str(r.headline, "Welcome"), subhead: str(r.subhead, "Shop our latest") }; },
  catalogRefs: () => ({ productIds: [], collectionHandles: [] }),
  Component: ({ props }) =>
    createElement("section", { className: "cd-block cd-block--hero" },
      createElement("h1", { className: "cd-hero__headline" }, props.headline),
      createElement("p", { className: "cd-hero__subhead" }, props.subhead)),
};

interface RichTextProps { html: string }
const richText: BlockMeta<RichTextProps> = {
  type: "richText", flavor: "static", allowedDocKinds: ["singleton", "template"],
  defaultProps: { html: "Tell your story." },
  defaultLayout: { x: 0, y: 0, w: 12, h: 2 },
  validateProps: (raw) => ({ html: str(asRecord(raw).html, "") }),
  catalogRefs: () => ({ productIds: [], collectionHandles: [] }),
  // ponytail: plain text only — NOT dangerouslySetInnerHTML. Rich formatting is the editor's
  // job later via a sanitized prop; rendering merchant/AI HTML raw would be an XSS sink.
  Component: ({ props }) => createElement("div", { className: "cd-block cd-block--text" }, props.html),
};

interface ImageProps { url: string; alt: string }
const image: BlockMeta<ImageProps> = {
  type: "image", flavor: "static", allowedDocKinds: ["singleton", "template"],
  defaultProps: { url: "", alt: "" },
  defaultLayout: { x: 0, y: 0, w: 6, h: 4 },
  validateProps: (raw) => { const r = asRecord(raw); return { url: str(r.url), alt: str(r.alt) }; },
  catalogRefs: () => ({ productIds: [], collectionHandles: [] }),
  Component: ({ props }) =>
    props.url ? createElement("img", { className: "cd-block cd-block--image", src: props.url, alt: props.alt }) : null,
};

interface ButtonProps { label: string; href: string }
const button: BlockMeta<ButtonProps> = {
  type: "button", flavor: "static", allowedDocKinds: ["singleton", "template"],
  defaultProps: { label: "Shop now", href: "/storefront" },
  defaultLayout: { x: 0, y: 0, w: 3, h: 1 },
  validateProps: (raw) => { const r = asRecord(raw); return { label: str(r.label, "Shop now"), href: str(r.href, "/storefront") }; },
  catalogRefs: () => ({ productIds: [], collectionHandles: [] }),
  Component: ({ props }) =>
    createElement("a", { className: "cd-block cd-block--button", href: props.href }, props.label),
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
  Component: ({ props, ctx }) =>
    createElement("section", { className: "cd-block cd-block--grid" },
      props.heading ? createElement("h2", { className: "cd-grid__heading" }, props.heading) : null,
      createElement("div", { className: "cd-store__grid" },
        gridProducts(props.source, ctx).map((p) =>
          createElement("a", { key: p.id, className: "cd-product-card", href: `/storefront/products/${p.handle}` },
            p.images[0] ? createElement("img", { className: "cd-product-card__img", src: p.images[0].url, alt: p.images[0].alt ?? p.title }) : null,
            createElement("span", { className: "cd-product-card__title" }, p.title),
            createElement("span", { className: "cd-product-card__price" }, money(p)))))),
};

interface CollectionListProps { heading: string }
const collectionList: BlockMeta<CollectionListProps> = {
  type: "collectionList", flavor: "dynamic", allowedDocKinds: ["singleton"],
  defaultProps: { heading: "Collections" },
  defaultLayout: { x: 0, y: 0, w: 12, h: 1 },
  validateProps: (raw) => ({ heading: str(asRecord(raw).heading, "Collections") }),
  catalogRefs: () => ({ productIds: [], collectionHandles: [] }),
  Component: ({ props, ctx }) =>
    createElement("nav", { className: "cd-block cd-block--collections" },
      props.heading ? createElement("h2", null, props.heading) : null,
      ctx.data.collections.map((c) =>
        createElement("a", { key: c.handle, href: `/storefront/collections/${c.handle}` }, c.title))),
};

// Exported as a plain array; the registry indexes it by type (Task 3).
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous BlockMeta<P> union; registry narrows by type
export const STARTER_BLOCKS: BlockMeta<any>[] = [hero, richText, image, button, productGrid, collectionList];
