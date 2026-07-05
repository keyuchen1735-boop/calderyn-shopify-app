// app/lib/storebuilder/studio-types.ts
// Plain DTOs for the Store studio surface, shared by the /dashboard/api/store
// route (server) and the dashboard SPA client. No server imports — this module
// must stay safe to pull into the browser bundle.

/** Mirrors the store_settings.vibe check constraint — the design pack the
 *  storefront CSS keys off ([data-vibe]). */
export type StudioVibe = "minimal" | "bold" | "warm";

/** Brand chrome shown in the studio preview, shaped from store_settings. */
export interface StudioSettings {
  storeName: string;
  /** Palette primary (falls back to the storefront default palette). */
  accent: string;
  vibe: StudioVibe;
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

/** POST {action:"generate"} response. A hard failure (nothing produced at all)
 *  surfaces as a 502; "failed" here is a SOFT-degraded success — a publishable
 *  draft was written, but the AI was unavailable so every page fell back to a
 *  deterministic starter layout that ignores the brief. */
export interface StudioGenerateReceipt {
  runId: string;
  status: "draft" | "no_products" | "failed";
}
