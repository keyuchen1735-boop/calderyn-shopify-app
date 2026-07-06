// app/lib/storebuilder/links.ts
// How a rendered store builds its navigation hrefs. Blocks never hardcode a URL — they ask the
// active StoreLinks so the SAME blocks power two surfaces: the live storefront (real /storefront
// paths) and the studio preview iframe (which must navigate WITHIN itself, never eject to the
// live store). Pure string builders — trivially testable, no React/DOM.
export interface StoreLinks {
  product(handle: string): string;
  collection(handle: string): string;
  /** Map an arbitrary block href (e.g. a button CTA). Default identity; preview folds
   *  /storefront* back into the preview home so a CTA never escapes the iframe. */
  href(raw: string): string;
}

// The live storefront: the paths the storefront routes actually serve.
export const STOREFRONT_LINKS: StoreLinks = {
  product: (handle) => `/storefront/products/${handle}`,
  collection: (handle) => `/storefront/collections/${handle}`,
  href: (raw) => raw,
};

const PREVIEW = "/dashboard/store/preview";

// The studio preview: every catalog link points back at the preview route so clicking a product
// or collection re-renders that page inside the same iframe (see dashboard.store.preview.tsx).
export const PREVIEW_LINKS: StoreLinks = {
  product: (handle) => `${PREVIEW}?page=pdp&handle=${encodeURIComponent(handle)}`,
  collection: (handle) => `${PREVIEW}?page=collection&handle=${encodeURIComponent(handle)}`,
  // A CTA aimed at the live store (/storefront…) folds to the preview home; anything else
  // (external URL, unrelated path) is left alone.
  href: (raw) => (/^\/storefront(\/|$|\?|#)/.test(raw) ? `${PREVIEW}?page=home` : raw),
};
