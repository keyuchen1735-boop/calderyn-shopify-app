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
}

export type DesignerRoute = "home" | "collection" | "product" | "search" | "cart" | "checkout";

export interface DesignerReply {
  /** The assistant's one-or-two sentence chat reply. */
  reply: string;
  /** Whether any document changed (the preview should reload). */
  changed: boolean;
  /** Edits that failed to apply after the retry, for observability. */
  rejectedEdits: number;
}
