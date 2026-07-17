// app/lib/storebuilder/blocks-product.tsx
// Template/functional blocks for collection + PDP docs. Unlike the starter blocks,
// these read the current record off ctx.record (set by the storefront route), so they
// carry NO hardcoded catalog ids (catalogRefs always empty) and are allowedDocKinds:["template"].
// addToCart is the buy-path action block — a native <form method="post"> with no JS dependency.
// price + variantPicker are the display pair; the required-on-PDP invariant ensures all three appear.
import { createElement } from "react";
import type { BlockMeta, RenderContext } from "./types";
import { STOREFRONT_LINKS } from "./links";
import type { StoreProduct } from "~/lib/storefront/catalog";
import { formatMoney as money } from "~/lib/storefront/money";

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const recProduct = (ctx: RenderContext): StoreProduct | undefined => ctx.record?.product;

interface GalleryProps { maxImages: number }
const productGallery: BlockMeta<GalleryProps> = {
  type: "productGallery", flavor: "dynamic", allowedDocKinds: ["template"],
  defaultProps: { maxImages: 6 }, defaultLayout: { x: 0, y: 0, w: 6, h: 6 },
  validateProps: (raw) => { const n = Number(asRecord(raw).maxImages); return { maxImages: Number.isFinite(n) && n > 0 ? Math.min(n, 12) : 6 }; },
  catalogRefs: () => ({ productIds: [], collectionHandles: [] }),
  Component: ({ props, ctx }) => {
    const p = recProduct(ctx);
    if (!p) return null;
    return createElement("div", { className: "cd-block cd-block--gallery" },
      p.images.slice(0, props.maxImages).map((img) =>
        createElement("img", { key: img.url, className: "cd-gallery__img", src: img.url, alt: img.alt ?? p.title })));
  },
};

// Every doc-driven PDP needs the product's NAME on the page; static blocks
// can't carry per-record text, so this reads ctx.record like price does.
const productTitle: BlockMeta = {
  type: "productTitle", flavor: "dynamic", allowedDocKinds: ["template"],
  defaultProps: {}, defaultLayout: { x: 6, y: 0, w: 6, h: 1 },
  validateProps: () => ({}),
  catalogRefs: () => ({ productIds: [], collectionHandles: [] }),
  Component: ({ ctx }) => {
    const p = recProduct(ctx);
    if (!p) return null;
    return createElement("div", { className: "cd-block cd-block--product-title" },
      createElement("h1", { className: "cd-pdp__title" }, p.title),
      p.description ? createElement("p", { className: "cd-pdp__description" }, p.description) : null);
  },
};

const price: BlockMeta = {
  type: "price", flavor: "dynamic", allowedDocKinds: ["template"],
  defaultProps: {}, defaultLayout: { x: 6, y: 0, w: 6, h: 1 },
  validateProps: () => ({}),
  catalogRefs: () => ({ productIds: [], collectionHandles: [] }),
  Component: ({ ctx }) => {
    const v = recProduct(ctx)?.variants[0];
    if (!v) return null;
    // A compare-at above the selling price renders as a struck-through "was"
    // price beside the current one; anything else (absent/equal/lower) is noise.
    const compareAt = v.compareAtPriceCents;
    const onSale = compareAt != null && compareAt > v.priceCents;
    return createElement(
      "div",
      { className: "cd-block cd-block--price" },
      onSale ? createElement("s", { className: "cd-price__compare" }, money(compareAt, v.currency)) : null,
      onSale ? " " : null,
      money(v.priceCents, v.currency),
    );
  },
};

const variantPicker: BlockMeta = {
  type: "variantPicker", flavor: "dynamic", allowedDocKinds: ["template"],
  defaultProps: {}, defaultLayout: { x: 6, y: 1, w: 6, h: 2 },
  validateProps: () => ({}),
  catalogRefs: () => ({ productIds: [], collectionHandles: [] }),
  Component: ({ ctx }) => {
    const p = recProduct(ctx);
    if (!p) return null;
    return createElement("ul", { className: "cd-block cd-block--variants" },
      p.variants.map((v) =>
        createElement("li", { key: v.id, className: "cd-variant" }, `${v.title}${v.available ? "" : " (sold out)"}`)));
  },
};

const addToCart: BlockMeta = {
  type: "addToCart", flavor: "functional", allowedDocKinds: ["template"],
  defaultProps: {}, defaultLayout: { x: 6, y: 3, w: 6, h: 1 },
  validateProps: () => ({}),
  catalogRefs: () => ({ productIds: [], collectionHandles: [] }),
  Component: ({ ctx }) => {
    const p = recProduct(ctx);
    const buyable = (p?.variants ?? []).filter((v) => v.available);
    if (!p || buyable.length === 0) {
      return createElement("button", { className: "cd-block cd-block--addtocart", type: "button", disabled: true }, "Sold out");
    }
    // Native post to the current PDP route URL; that route's action reads variantId.
    const selector = buyable.length > 1
      ? createElement("select", { name: "variantId", className: "cd-addtocart__select", "aria-label": "Choose an option" },
          buyable.map((v) => createElement("option", { key: v.id, value: v.id }, v.title)))
      : createElement("input", { type: "hidden", name: "variantId", value: buyable[0].id });
    return createElement("form", { method: "post", className: "cd-block cd-block--addtocart" },
      selector,
      createElement("button", { type: "submit", className: "cd-addtocart__buy" }, "Add to cart"));
  },
};

const collectionGrid: BlockMeta = {
  type: "collectionGrid", flavor: "dynamic", allowedDocKinds: ["template"],
  defaultProps: {}, defaultLayout: { x: 0, y: 0, w: 12, h: 6 },
  validateProps: () => ({}),
  catalogRefs: () => ({ productIds: [], collectionHandles: [] }),
  Component: ({ ctx }) => {
    const handle = ctx.record?.collection?.handle;
    const products = handle ? (ctx.data.productsByCollection[handle] ?? []) : [];
    const links = ctx.links ?? STOREFRONT_LINKS;
    return createElement("div", { className: "cd-block cd-store__grid" },
      products.map((p) => {
        const description = p.description.trim();
        const excerpt = description.length > 160 ? `${description.slice(0, 159).trimEnd()}…` : description;
        return createElement("a", { key: p.id, className: "cd-product-card", href: links.product(p.handle) },
          p.images[0] ? createElement("img", { className: "cd-product-card__img", src: p.images[0].url, alt: p.images[0].alt ?? p.title }) : null,
          createElement("span", { className: "cd-product-card__title" }, p.title),
          excerpt ? createElement("span", { className: "cd-product-card__description" }, excerpt) : null,
          createElement("span", { className: "cd-product-card__price" }, p.variants[0] ? money(p.variants[0].priceCents, p.variants[0].currency) : ""));
      }));
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous BlockMeta<P> union; registry narrows by type
export const STARTER_PRODUCT_BLOCKS: BlockMeta<any>[] = [productGallery, productTitle, price, variantPicker, addToCart, collectionGrid];
