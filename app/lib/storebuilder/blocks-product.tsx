// app/lib/storebuilder/blocks-product.tsx
// Template/functional blocks for collection + PDP docs. Unlike the starter blocks,
// these read the current record off ctx.record (set by the storefront route), so they
// carry NO hardcoded catalog ids (catalogRefs always empty) and are allowedDocKinds:["template"].
// ponytail: addToCart is the one wired buy-path block (a native <form> posting to the current
// PDP route action, which already handles variantId — no JS, SSR-safe). price + variantPicker
// are buy-path DISPLAY blocks; the required-on-PDP invariant guarantees the trio is always shown.
import { createElement } from "react";
import type { BlockMeta, RenderContext } from "./types";
import type { StoreProduct } from "~/lib/storefront/catalog";

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const recProduct = (ctx: RenderContext): StoreProduct | undefined => ctx.record?.product;
function money(cents: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(cents / 100);
}

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
      p.images.slice(0, props.maxImages).map((img, i) =>
        createElement("img", { key: i, className: "cd-gallery__img", src: img.url, alt: img.alt ?? p.title })));
  },
};

const price: BlockMeta = {
  type: "price", flavor: "functional", allowedDocKinds: ["template"],
  defaultProps: {}, defaultLayout: { x: 6, y: 0, w: 6, h: 1 },
  validateProps: () => ({}),
  catalogRefs: () => ({ productIds: [], collectionHandles: [] }),
  Component: ({ ctx }) => {
    const v = recProduct(ctx)?.variants[0];
    if (!v) return null;
    return createElement("div", { className: "cd-block cd-block--price" }, money(v.priceCents, v.currency));
  },
};

const variantPicker: BlockMeta = {
  type: "variantPicker", flavor: "functional", allowedDocKinds: ["template"],
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
    return createElement("div", { className: "cd-block cd-store__grid" },
      products.map((p) =>
        createElement("a", { key: p.id, className: "cd-product-card", href: `/storefront/products/${p.handle}` },
          p.images[0] ? createElement("img", { className: "cd-product-card__img", src: p.images[0].url, alt: p.images[0].alt ?? p.title }) : null,
          createElement("span", { className: "cd-product-card__title" }, p.title),
          createElement("span", { className: "cd-product-card__price" }, p.variants[0] ? money(p.variants[0].priceCents, p.variants[0].currency) : ""))));
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous BlockMeta<P> union; registry narrows by type
export const STARTER_PRODUCT_BLOCKS: BlockMeta<any>[] = [productGallery, price, variantPicker, addToCart, collectionGrid];
