// app/lib/storebuilder/studio-types.ts
// Plain DTOs for the Store studio surface, shared by the /dashboard/api/store
// route (server) and the dashboard SPA client. No server imports — this module
// must stay safe to pull into the browser bundle.

/** Mirrors the store_settings.vibe check constraint — the design pack the
 *  storefront CSS keys off ([data-vibe]). */
export type StudioVibe = "minimal" | "bold" | "warm";

/** Mirrors the store_settings.type_style check constraint. "classic" defers to
 *  the vibe's font (no [data-type] override); editorial/rounded set their own. */
export type StudioTypeStyle = "classic" | "editorial" | "rounded";

/** Mirrors the store_settings.density check constraint (storefront [data-density]
 *  spacing pack). "standard" = today's spacing. */
export type StudioDensity = "compact" | "standard" | "roomy";

/** Brand chrome shown in the studio preview, shaped from store_settings. */
export interface StudioSettings {
  storeName: string;
  /** Palette primary (falls back to the storefront default palette). */
  accent: string;
  vibe: StudioVibe;
  typeStyle?: StudioTypeStyle;
  density?: StudioDensity;
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

/** Mirrors the store_experiment.state check constraint. */
export type StudioExperimentState = "running" | "decided_ship" | "decided_keep" | "stopped";

export interface StudioExperimentReport {
  /** Distinct sessions that saw each arm (page_view exposure rows). */
  aSessions: number;
  bSessions: number;
  /** Distinct converted sessions per arm (orders attribution stamp, unioned
   *  with checkout_complete exposure sessions as fallback). */
  aConversions: number;
  bConversions: number;
  /** (rB - rA) / rA; null when arm A has no conversions to compare against. */
  lift: number | null;
  /** Two-proportion z-test confidence, 0-99; null under 30 sessions per arm. */
  confidence: number | null;
}

export interface StudioExperiment {
  id: string;
  name: string;
  why: string;
  pageKey: "home";
  state: StudioExperimentState;
  startedAt: string;
  decidedAt: string | null;
  report: StudioExperimentReport | null;
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
  /** shops.org_slug — null for domain-keyed Shopify tenants and the demo shop. */
  orgSlug: string | null;
  /** Absolute tenant URL when org_slug exists, else the fixed app path (which
   *  on the dashboard origin resolves to the demo shell). */
  storefrontUrl: string;
  /** The running or most recent experiment, with a fresh report; null when the
   *  shop has never run one. */
  experiment: StudioExperiment | null;
}

/** Merchant-facing design-model choice for a generation run. The client only
 *  ever sends this key; the server maps it to a concrete model id, so a
 *  request can never bill an arbitrary model. */
export type StudioDesignModel = "sonnet" | "opus";

/** One entry PER attached image on the add-as-products path — every image is
 *  accounted for, in attachment order:
 *  - `id` set, no error fields → created with its image.
 *  - `id` + `imageError` → the product row was written but its image failed to
 *    attach — a partial add the caller must surface (a retry would mint a
 *    duplicate product), never a silent success.
 *  - `error`, no `id` → the product row itself failed to create; nothing exists
 *    for this attachment (safe to retry just this one). */
export interface StudioAddedProduct {
  /** Absent only when creation itself failed (see `error`). */
  id?: string;
  title: string;
  imageError?: string;
  error?: string;
}

/** The model's decision for images that travelled with the prompt. */
export interface StudioAttachmentIntent {
  /** The images depict the merchant's own products → added as draft products. */
  addAsProducts: boolean;
  /** The images are style references the store's design drew from. */
  useAsReference: boolean;
}

/** POST {action:"generate"} response. A hard failure (nothing produced at all)
 *  surfaces as a 502; "failed" here is a SOFT-degraded success — a publishable
 *  draft was written, but the AI was unavailable so every page fell back to a
 *  deterministic starter layout that ignores the brief.
 *
 *  When images travel with the prompt (multipart) the server first decides intent:
 *  - "needs_intent": it couldn't tell what to do with the images and is asking the
 *    merchant — no run, no products, no `runId`.
 *  - "products_added": the images became draft products with no generation — no `runId`.
 *  - "failed" WITH `products` and NO `runId`: products were created, then the
 *    generation call itself threw — both facts in one honest receipt (the pure
 *    JSON path and the products-free reference path keep their 502 instead).
 *  `runId` is present only when a generation actually ran; `intent`/`products` are
 *  present only on the multipart path (the plain JSON path returns just runId+status). */
export interface StudioGenerateReceipt {
  runId?: string;
  status: "draft" | "no_products" | "failed" | "needs_intent" | "products_added";
  /** The model's intent decision for attached images (multipart path only). */
  intent?: StudioAttachmentIntent;
  /** One entry per attached image on the add-as-products path (see StudioAddedProduct). */
  products?: StudioAddedProduct[];
  /** Best-effort attribution: the generation ran, but every call that carried the
   *  merchant's reference images failed while text-only calls succeeded — the
   *  produced design never saw the references. */
  referencesUnread?: true;
}
