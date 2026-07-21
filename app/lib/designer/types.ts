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
    /** Default variant to add to cart from listing cards; null = not buyable. */
    variantId?: string | null;
  }>;
  /** Generated imagery by key, resolved via the {{asset.<key>}} placeholder. */
  assets?: Record<string, string>;
  /** Live-serve context: the real collection title for {{collection.title}}. */
  collectionTitle?: string;
  /** Live-serve context: the query echoed by {{search.query}}. */
  searchQuery?: string;
  /** Discount codes the platform can actually redeem. The coupon widget only
   *  renders for a code in this list — and no discounts feature exists yet, so
   *  nothing populates it and fresh builds emit no coupon markup (spec D5). */
  redeemableCodes?: string[];
  /** Free-shipping thresholds (whole dollars) backed by real merchant
   *  shipping settings. A declared cart meter or "free shipping over $N"
   *  line only renders for a number in this list — nothing populates it yet,
   *  so every fabricated threshold degrades to generic copy at serve time
   *  (spec D5, same honesty contract as redeemableCodes). */
  backedFreeShippingThresholds?: number[];
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

/** One line of the edit-result card: a merchant-facing surface label (e.g.
 *  "Home page", "Site styles") with the real lines added/removed this turn. */
export interface DesignerChange {
  label: string;
  added: number;
  removed: number;
}

export interface DesignerReply {
  /** The assistant's one-or-two sentence chat reply. */
  reply: string;
  /** Whether any document changed (the preview should reload). */
  changed: boolean;
  /** Edits that failed to apply after the retry, for observability. */
  rejectedEdits: number;
  /** Per-surface summary of what this turn changed, for the result card. */
  changes?: DesignerChange[];
}
