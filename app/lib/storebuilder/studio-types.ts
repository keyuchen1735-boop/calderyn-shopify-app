// app/lib/storebuilder/studio-types.ts
// Plain DTOs for the Store studio surface, shared by the /dashboard/api/store
// route (server) and the dashboard SPA client. No server imports — this module
// must stay safe to pull into the browser bundle.

/** Brand chrome shown in the studio preview, shaped from store_settings. */
export interface StudioSettings {
  storeName: string;
  /** Palette primary (falls back to the storefront default palette). */
  accent: string;
  logoUrl: string | null;
  tagline: string | null;
}

/**
 * The hero block's REAL text fields (see app/lib/storebuilder/blocks.tsx:
 * `HeroProps { headline; subhead }`). The studio renders `subhead` in the
 * eyebrow slot above the headline — the field names here stay honest to the
 * block schema rather than renaming subhead to "eyebrow" on the wire.
 */
export interface StudioHero {
  headline: string;
  subhead: string;
}

export interface StudioProduct {
  id: string;
  title: string;
  priceCents: number | null;
  imageUrl: string | null;
}

/** Mirrors the store_generation.status check constraint. */
export type StudioGenerationStatus = "draft" | "failed" | "no_products";

export interface StudioGeneration {
  runId: string;
  status: StudioGenerationStatus;
  brief: string | null;
  createdAt: string;
}

export interface StudioState {
  settings: StudioSettings;
  /** From the draft home doc's hero block (published as fallback); null when
   *  no doc exists yet or the doc has no hero block. */
  hero: StudioHero | null;
  /** First 3 catalog products for the preview grid. */
  products: StudioProduct[];
  /** Live (active) products the storefront renders — the preview list above is capped at 3. */
  productCount: number;
  /** Products still in draft status (e.g. created from chat-box attachments). */
  draftProductCount: number;
  /** Whether payments are fully set up (Stripe charges + payouts + details). */
  checkoutReady: boolean;
  hasDraft: boolean;
  hasPublished: boolean;
  /** Latest store_generation row, or null when the shop has never generated. */
  generation: StudioGeneration | null;
  /** Where the public storefront is served (no custom-domain support yet). */
  storefrontPath: string;
}

/** POST {action:"generate"} response — generateStore never resolves "failed"
 *  (a hard failure surfaces as a 502 instead). */
export interface StudioGenerateReceipt {
  runId: string;
  status: "draft" | "no_products";
}
