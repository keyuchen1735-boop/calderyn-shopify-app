export interface DesignerStoreData {
  storeName: string;
  tagline: string | null;
  logoUrl: string | null;
  products: Array<{
    id: string;
    handle: string;
    title: string;
    description: string | null;
    priceCents: number | null;
    compareAtPriceCents: number | null;
    available: boolean;
    imageUrl: string | null;
  }>;
  /** Generated imagery by key, resolved via the {{asset.<key>}} placeholder. */
  assets?: Record<string, string>;
}

export type DesignerRoute = "home" | "collection" | "product" | "search" | "cart" | "checkout";

// DesignerStoreData.assets: generated imagery by key, resolved through the
// {{asset.<key>}} placeholder (e.g. {{asset.hero}}).

/** Loader payload for a PUBLISHED designer page served on the public
 *  storefront. Client-safe: route components render it bare (no layout
 *  chrome) with the nonce'd runtime cart script. */
export interface DesignerPublicPage {
  designer: true;
  bodyHtml: string;
  css: string;
  nonce: string;
  cartScript: string;
  seoMeta: Array<{ title: string }>;
}

/** Narrow a storefront loader payload to the designer branch. */
export function isDesignerPublicPage(value: unknown): value is DesignerPublicPage {
  return Boolean(value && typeof value === "object" && (value as { designer?: unknown }).designer === true);
}

export interface DesignerReply {
  /** The assistant's one-or-two sentence chat reply. */
  reply: string;
  /** Whether any document changed (the preview should reload). */
  changed: boolean;
  /** Edits that failed to apply after the retry, for observability. */
  rejectedEdits: number;
}
