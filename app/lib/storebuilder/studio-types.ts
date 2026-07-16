// app/lib/storebuilder/studio-types.ts
// Plain DTOs for the Store studio surface, shared by the /dashboard/api/store
// route (server) and the dashboard SPA client. No server imports — this module
// must stay safe to pull into the browser bundle.
import type { StoreDesignResolution } from "~/lib/storefront-bundle/types";

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
  /** Hidden Labs switch: chat builds route through the from-scratch designer. */
  composerEnabled?: boolean;
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

/** Mirrors the store_experiment.page_key check constraint — the storefront page under test. */
export type StudioExperimentPage = "home" | "pdp";

/** Challenger recipes the studio can start. headline/vibe/ai_page test the home page;
 *  pdp_copy tests the product-page template. */
export type StudioExperimentKind = "headline" | "vibe" | "pdp_copy" | "ai_page";
/** The single runtime list behind StudioExperimentKind — the API route validates against it
 *  and the client narrows from it, so adding a kind is a one-line change here. */
export const STUDIO_EXPERIMENT_KINDS: readonly StudioExperimentKind[] = ["headline", "vibe", "pdp_copy", "ai_page"];

export interface StudioExperimentReport {
  /** Distinct sessions that saw each arm (page_view exposure rows). */
  aSessions: number;
  bSessions: number;
  /** Distinct converted sessions per arm (orders attribution stamp, unioned
   *  with checkout_complete exposure sessions as fallback). */
  aConversions: number;
  bConversions: number;
  /** Sum of order totals per arm across stamped sale-state orders. Fallback
   *  conversions (checkout_complete sessions with no stamped order) add 0. */
  aRevenueCents: number;
  bRevenueCents: number;
  /** Distinct sessions per arm at each mid-funnel step (cart_add /
   *  checkout_start exposure rows). */
  funnel: {
    aCartAdds: number;
    bCartAdds: number;
    aCheckoutStarts: number;
    bCheckoutStarts: number;
  };
  /** (rB - rA) / rA; null when arm A has no conversions to compare against. */
  lift: number | null;
  /** Two-proportion z-test confidence, 0-99; null under 30 sessions per arm. */
  confidence: number | null;
}

export interface StudioExperiment {
  id: string;
  name: string;
  why: string;
  pageKey: StudioExperimentPage;
  state: StudioExperimentState;
  startedAt: string;
  decidedAt: string | null;
  report: StudioExperimentReport | null;
}

/** One editable piece of the home page, derived from the draft doc's blocks.
 *  "design" sections (AI-authored HTML) can be regenerated; catalog sections
 *  (live product grid / category cards) and "content" sections (plain template
 *  blocks like a hero or feature row) can only be moved or removed. */
export interface StudioSection {
  /** The underlying block id — the handle every section mutation takes. */
  id: string;
  kind: "design" | "products" | "collections" | "content";
  /** Short human label: the section's first heading, or the catalog block's role. */
  title: string;
}

export type StudioPolicyId = "privacy" | "terms" | "refund" | "shipping";

/** Merchant-authored legal copy only. Missing policies stay missing instead of
 * being populated with generic text that may not match the merchant's store. */
export interface StudioPolicy {
  id: StudioPolicyId;
  title: string;
  body: string;
  updatedAt: string;
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
  /** Immutable bundle pointers alongside runtime-0 page-document compatibility. */
  release: {
    draftVersionId: string | null;
    publishedVersionId: string | null;
    draftRuntime: 0 | 1;
    publishedRuntime: 0 | 1;
  };
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
  /** Editable sections of the home draft (published as fallback), in page order.
   *  Empty when no doc exists yet. */
  sections: StudioSection[];
  /** Persisted merchant policies. Sparse by design: no fabricated legal copy. */
  policies: StudioPolicy[];
}

/** Merchant-facing design-model choice for a generation run. The client only
 *  ever sends this key; the server maps it to a concrete model id, so a
 *  request can never bill an arbitrary model. */
export type StudioDesignModel = "sonnet" | "opus";

/** Image media types the multipart generate path accepts (what the Anthropic
 *  image API takes) — the single allowlist for BOTH sides: the composer screens
 *  staged files against it, the route 422s anything else. One source of truth
 *  so a type the client stages can never dead-end at the server. */
export const STUDIO_IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

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
  /** Pre-present verification results from the streaming generate path: links
   *  re-checked against the live catalog, runtime-rejected fx stripped. */
  verification?: {
    checkedLinks: number;
    fixedLinks: number;
    externalLinks: number;
    strippedMotion: number;
    warnings: string[];
  };
}

// ---- streaming build events (chat progress) ---------------------------------------------------

/** Real generation stages, streamed by the server as they happen (mirrors
 *  generate.server.ts BuildStage — a server-only module clients can't import). */
export type LegacyBuildStage = "brand" | "designing" | "checking";
export type Runtime1BuildStage = "routing" | "applying_recipe" | "generating_original" | "compiling" | "validating" | "proofing";
export type BuildStage = LegacyBuildStage | Runtime1BuildStage;
export const BUILD_STAGES: readonly BuildStage[] = [
  "brand",
  "designing",
  "checking",
  "routing",
  "applying_recipe",
  "compiling",
  "validating",
  "proofing",
];

export interface StudioBundleBuildReceipt {
  runtime: 1;
  versionId: string;
  status: "draft";
  resolution: StoreDesignResolution;
}

/** One NDJSON line from the streaming generate endpoint. */
export type BuildEvent =
  | { stage: LegacyBuildStage }
  | {
      stage: "routing";
      resolution: StoreDesignResolution;
      recommendationChanged: boolean;
      recommendationChangeReason?: string;
    }
  | { stage: "applying_recipe"; templateId: string; templateVersion: number }
  | { stage: "generating_original" }
  | { stage: "compiling" | "validating" | "proofing" }
  | { stage: "installed"; receipt: StudioBundleBuildReceipt }
  | { stage: "done"; receipt: StudioGenerateReceipt }
  | { stage: "error"; message: string; code?: string; status?: number };

/** Strict parse of one stream line — junk, unknown stages and malformed terminal
 *  lines are null (callers treat an unparseable stream as a failed stream). */
export function parseBuildEvent(line: string): BuildEvent | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (["brand", "designing", "checking", "compiling", "validating", "proofing"].includes(String(o.stage))) {
    return { stage: o.stage as LegacyBuildStage | "compiling" | "validating" | "proofing" };
  }
  if (
    o.stage === "routing" &&
    typeof o.resolution === "object" && o.resolution !== null &&
    typeof o.recommendationChanged === "boolean"
  ) {
    return {
      stage: "routing",
      resolution: o.resolution as StoreDesignResolution,
      recommendationChanged: o.recommendationChanged,
      ...(typeof o.recommendationChangeReason === "string"
        ? { recommendationChangeReason: o.recommendationChangeReason }
        : {}),
    };
  }
  if (o.stage === "applying_recipe" && typeof o.templateId === "string" && typeof o.templateVersion === "number") {
    return { stage: "applying_recipe", templateId: o.templateId, templateVersion: o.templateVersion };
  }
  if (o.stage === "generating_original") return { stage: "generating_original" };
  if (o.stage === "installed" && typeof o.receipt === "object" && o.receipt !== null) {
    return { stage: "installed", receipt: o.receipt as StudioBundleBuildReceipt };
  }
  if (o.stage === "done" && typeof o.receipt === "object" && o.receipt !== null) {
    return { stage: "done", receipt: o.receipt as StudioGenerateReceipt };
  }
  if (o.stage === "error" && typeof o.message === "string") {
    return {
      stage: "error",
      message: o.message,
      ...(typeof o.code === "string" ? { code: o.code } : {}),
      ...(typeof o.status === "number" && Number.isInteger(o.status) ? { status: o.status } : {}),
    };
  }
  return null;
}
