export const STOREFRONT_SCHEMA_VERSION = 1 as const;
export const STOREFRONT_RUNTIME_VERSION = 1 as const;
export const STOREFRONT_VALIDATION_PROFILE_VERSION = 1 as const;

export type StoreTemplateId =
  | "custom-bench"
  | "commons-index"
  | "soft-chemistry"
  | "companion-field-guide"
  | "daily-protocol"
  | "room-modes"
  | "rep-rest"
  | "diagnostic-deck"
  | "ritual-almanac"
  | "broadcast-patch-bay"
  | "atelier-nine";

export type StoreDesignMode = "auto" | "recipe" | "custom";

export interface StoreDesignRequest {
  prompt: string;
  mode: StoreDesignMode;
  templateId?: StoreTemplateId;
}

export interface CatalogRoutingEvidence {
  productTitles: string[];
  productTypes: string[];
  productTags: string[];
  optionNames: string[];
  collectionTitles: string[];
  fingerprint: string;
}

export type CatalogRoutingField = keyof Omit<CatalogRoutingEvidence, "fingerprint">;

export interface RoutingScoreBreakdown {
  templateId: StoreTemplateId;
  aliasHits: string[];
  strongPhraseHits: string[];
  promptTermHits: string[];
  catalogTermHits: Array<{ term: string; field: CatalogRoutingField }>;
  score: number;
}

interface ResolutionMetadata {
  routingVersion: number;
  registryVersion: number;
  catalogFingerprint: string;
  breakdown: RoutingScoreBreakdown[];
  reasons: string[];
}

export type StoreDesignResolution =
  | (ResolutionMetadata & {
      kind: "recipe";
      templateId: StoreTemplateId;
      templateVersion: number;
      selectionKind: "manual_override" | "explicit_name" | "niche_match";
      score: number | null;
      runnerUpScore: number | null;
      margin: number | null;
      confidenceBand: "high" | "medium" | null;
    })
  | (ResolutionMetadata & {
      kind: "custom";
      reason: "explicit_custom" | "low_confidence" | "ambiguous_recipe_names" | "manual_override";
    });

export type StorefrontRouteId = "home" | "collection" | "product" | "search" | "cart" | "checkout";

export interface RecipeOverrideSurface {
  designTokens: readonly string[];
  textSlots: readonly string[];
  optionalRegions: readonly string[];
  reorderableRegions: readonly string[];
}

export interface VersionedStoreTemplate {
  id: StoreTemplateId;
  name: string;
  niche: string;
  descriptor: string;
  aliases: readonly string[];
  strongPhrases: readonly string[];
  promptTerms: readonly string[];
  catalogTerms: readonly string[];
  activeVersion: number;
  routeCapabilities: readonly StorefrontRouteId[];
  overrideSurface: RecipeOverrideSurface;
  previewSrc: string;
  legacyVibe: "bold" | "minimal" | "warm";
  generationInstructions: string;
}

export interface VersionedStoreTemplateRegistry {
  registryVersion: number;
  routingVersion: number;
  templates: readonly VersionedStoreTemplate[];
}

export type CuratedFontId = string;
export type PublicBindingPath = string;
export type RuntimeCapability =
  | "navigation"
  | "localState"
  | "overlay"
  | "catalogFiltering"
  | "catalogSearch"
  | "commerce";

export type DataRequirement =
  | { kind: "storeIdentity" | "policyLinks" | "currentProduct" | "currentCollection" | "cart" }
  | { kind: "featuredProducts"; limit: number; collectionHandle?: string }
  | { kind: "relatedProducts" | "searchResults"; limit: number };

export interface AssetManifestEntry {
  key: string;
  contentHash: string;
  mediaType: string;
  byteSize: number;
}

export interface AssetManifest {
  entries: AssetManifestEntry[];
}

export interface RouteArtifact {
  html: string;
  css: string;
  requiredData: DataRequirement[];
  requiredCapabilities: RuntimeCapability[];
  interactions: InteractionManifestV1;
  trustedSlots: TrustedSlotManifest[];
}

export interface CheckoutRouteArtifact {
  decorativeHtml: string;
  decorativeCss: string;
  layout: CheckoutLayoutManifest;
  requiredData: Array<{ kind: "storeIdentity" | "policyLinks" }>;
}

export type PublicDataRef =
  | { kind: "data"; scopeId: string; path: PublicBindingPath }
  | { kind: "state"; stateId: string }
  | { kind: "event"; field: "value" | "checked" | "key" | "progress01" }
  | { kind: "literal"; value: string | number | boolean | null };

export interface RouteTarget {
  routeId: StorefrontRouteId | "account" | "policy";
  params: Partial<Record<"handle" | "query" | "policyId", PublicDataRef>>;
}

export interface TrustedSlotManifest {
  id: string;
  kind: "variantPicker" | "addToCart" | "cartLineControls" | "cartSummary" | "cartDrawer" | "quickViewCommerce";
  scopeId?: string;
  hostSize: "inline" | "block" | "panel" | "page";
  themeTokenIds: string[];
}

export interface CheckoutLayoutManifest {
  columnMode: "single" | "summaryAside" | "summaryFirst";
  sectionOrder: Array<"contact" | "shipping" | "delivery" | "consent" | "payment" | "summary">;
  spacingTokenId: string;
  surfaceTokenIds: string[];
}

export interface InteractionManifestV1 {
  version: 1;
  state: Array<{
    id: string;
    type: "boolean" | "enum" | "boundedNumber" | "index" | "textQuery";
    initial: boolean | string | number;
    allowedValues?: string[];
    min?: number;
    max?: number;
  }>;
  bindings: Array<{
    targetId: string;
    property: "hidden" | "expanded" | "selected" | "activeIndex" | "textQuery" | "classToken" | "progress01";
    stateId: string;
  }>;
  transitions: Array<{
    on: "click" | "change" | "input" | "keydown" | "inview" | "scrollProgress";
    sourceId: string;
    action: RuntimeActionSpec;
  }>;
}

export type RuntimeActionSpec =
  | { type: "state.set" | "state.increment" | "state.decrement"; stateId: string; value?: PublicDataRef }
  | { type: "surface.open" | "surface.close" | "surface.toggle"; surfaceId: string }
  | { type: "tabs.select" | "accordion.toggle" | "gallery.select"; targetId: string; value: PublicDataRef }
  | { type: "carousel.previous" | "carousel.next"; targetId: string }
  | { type: "collection.filter"; facetId: string; value: PublicDataRef }
  | { type: "collection.sort" | "collection.view"; value: PublicDataRef }
  | { type: "collection.page"; cursor: PublicDataRef }
  | { type: "search.update" | "search.submit"; query: PublicDataRef }
  | { type: "search.clear" }
  | { type: "scroll.to"; targetId: string }
  | { type: "navigate"; target: RouteTarget };

export interface StorefrontBundleV1 {
  schemaVersion: 1;
  runtimeVersion: 1;
  validationProfileVersion: 1;
  source:
    | { kind: "recipe"; templateId: StoreTemplateId; templateVersion: number }
    | {
        kind: "custom";
        generationId: string;
        promptHash: string;
        derivedFromVersionId?: string;
        derivedFromTemplateId?: StoreTemplateId;
        derivedFromTemplateVersion?: number;
      };
  concept: { name: string; rationale: string; noveltySignature: string[] };
  designSystem: {
    displayFontId: CuratedFontId;
    bodyFontId: CuratedFontId;
    tokens: Record<string, string>;
    breakpoints: Record<string, number>;
    iconStyle: string;
    motionStyle: string;
    globalCss: string;
  };
  shell: RouteArtifact;
  routes: {
    home: RouteArtifact;
    collection: RouteArtifact;
    product: RouteArtifact;
    search: RouteArtifact;
    cart: RouteArtifact;
    checkout: CheckoutRouteArtifact;
  };
  assets: AssetManifest;
}
