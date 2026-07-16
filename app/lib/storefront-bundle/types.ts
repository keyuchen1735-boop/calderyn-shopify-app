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

export type VisualLayerSpec =
  | { kind: "none" }
  | { kind: "fragment_shader"; source: string; colors: [string, string, string] };

export type StoreDesignMode = "auto" | "recipe" | "custom";

export interface StoreDesignRequest {
  prompt: string;
  mode: StoreDesignMode;
  templateId?: StoreTemplateId;
  excludedTemplateIds?: StoreTemplateId[];
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
      kind: "no_match";
      reason: "all_designs_excluded";
    })
  | (ResolutionMetadata & {
      kind: "custom";
      reason: "explicit_custom" | "low_confidence" | "ambiguous_recipe_names" | "manual_override";
    });

export type StorefrontRouteId = "home" | "collection" | "product" | "search" | "cart" | "checkout";
export type StorefrontRecipeBlueprintId = "shell" | StorefrontRouteId;

export const RECIPE_COMPOSITION_FAMILIES = [
  "workshop-configurator",
  "cooperative-directory",
  "clinical-editorial",
  "field-guide",
  "protocol-ledger",
  "spatial-scenes",
  "split-performance",
  "diagnostic-terminal",
  "editorial-almanac",
  "signal-patch-bay",
  "asymmetric-magazine",
] as const;
export type RecipeCompositionIdentity = (typeof RECIPE_COMPOSITION_FAMILIES)[number];
export const ROUTE_COMPOSITION_PATTERNS = {
  shell: "persistent-utility-frame",
  home: "narrative-entry-sequence",
  collection: "faceted-catalog-index",
  product: "media-purchase-split",
  search: "query-result-workspace",
  cart: "line-summary-ledger",
  checkout: "trust-rail-flow",
} as const;
export type RouteCompositionPattern = (typeof ROUTE_COMPOSITION_PATTERNS)[StorefrontRecipeBlueprintId];
export type RecipeCompositionFamily = `${RecipeCompositionIdentity}.${RouteCompositionPattern}.${StorefrontRecipeBlueprintId}`;

export const RECIPE_HERO_TREATMENTS = [
  "configurator-workbench",
  "impact-ledger-intro",
  "ingredient-routine-hero",
  "pet-profile-hero",
  "time-of-day-protocol",
  "room-mode-scene",
  "training-recovery-split",
  "grade-diagnostic-hero",
  "ritual-time-hero",
  "rig-signal-chain",
  "editorial-grid-hero",
] as const;
export type RecipeHeroIdentity = (typeof RECIPE_HERO_TREATMENTS)[number];
export const ROUTE_HERO_PATTERNS = {
  shell: "navigation-identity-band",
  home: "immersive-brand-intro",
  collection: "collection-context-banner",
  product: "product-media-stage",
  search: "query-state-header",
  cart: "order-review-header",
  checkout: "progress-trust-header",
} as const;
export type RouteHeroPattern = (typeof ROUTE_HERO_PATTERNS)[StorefrontRecipeBlueprintId];
export type RecipeHeroTreatment = `${RecipeHeroIdentity}.${RouteHeroPattern}.${StorefrontRecipeBlueprintId}`;

export const RECIPE_SCROLL_MODELS = [
  "guided-steps",
  "indexed-ledger",
  "soft-reveal",
  "chaptered-guide",
  "routine-timeline",
  "spatial-snap",
  "sticky-workout",
  "deck-snap",
  "almanac-chapters",
  "modular-patching",
  "restrained-editorial",
] as const;
export type RecipeScrollIdentity = (typeof RECIPE_SCROLL_MODELS)[number];
export const ROUTE_SCROLL_PATTERNS = {
  shell: "persistent-chrome",
  home: "narrative-sequence",
  collection: "sticky-facet-results",
  product: "sticky-purchase-detail",
  search: "sticky-query-results",
  cart: "synchronized-line-summary",
  checkout: "linear-step-flow",
} as const;
export type RouteScrollPattern = (typeof ROUTE_SCROLL_PATTERNS)[StorefrontRecipeBlueprintId];
export type RecipeScrollModel = `${RecipeScrollIdentity}.${RouteScrollPattern}.${StorefrontRecipeBlueprintId}`;

export const RECIPE_CARD_TOPOLOGIES = [
  "material-specimen-grid",
  "provenance-records",
  "ingredient-dossiers",
  "field-notes",
  "protocol-stacks",
  "scene-panels",
  "comparison-rails",
  "diagnostic-cards",
  "ritual-entries",
  "signal-modules",
  "magazine-grid",
] as const;
export type RecipeCardIdentity = (typeof RECIPE_CARD_TOPOLOGIES)[number];
export const ROUTE_CARD_PATTERNS = {
  shell: "navigation-utility-cluster",
  home: "featured-story-modules",
  collection: "browse-product-matrix",
  product: "related-product-rail",
  search: "ranked-result-list",
  cart: "editable-line-items",
  checkout: "fulfillment-payment-summary",
} as const;
export type RouteCardPattern = (typeof ROUTE_CARD_PATTERNS)[StorefrontRecipeBlueprintId];
export type RecipeCardTopology = `${RecipeCardIdentity}.${RouteCardPattern}.${StorefrontRecipeBlueprintId}`;

export type ProtectedStorefrontSlot =
  | "variantPicker"
  | "addToCart"
  | "productDescription"
  | "cartLineControls"
  | "cartSummary"
  | "cartDrawer"
  | "quickViewCommerce"
  | "checkoutRoot";

export interface RecipeProtectedSlotPlacement {
  slot: ProtectedStorefrontSlot;
  region: string;
}

export interface StoreTemplateRouteBlueprint {
  sourceRef: string;
  compositionFamily: RecipeCompositionFamily;
  heroTreatment: RecipeHeroTreatment;
  scrollModel: RecipeScrollModel;
  displayFontId: CuratedFontId;
  bodyFontId: CuratedFontId;
  iconRules: readonly string[];
  cardTopology: RecipeCardTopology;
  protectedSlotPlacement: readonly RecipeProtectedSlotPlacement[];
  signatureInteractions: readonly string[];
  forbiddenGenericStructures: readonly string[];
}

export interface TemplateVisualLayer {
  slotId: `visual:${string}`;
  fallbackAssetKey: string;
  placement: "hero-background" | "section-background";
  pointerEvents: "none";
}

export interface StoreTemplateVersionRecord {
  templateVersion: number;
  baselineArtifact: string;
  screenshots: Readonly<{
    desktop: string;
    mobile: string;
  }>;
  visualLayer: TemplateVisualLayer;
  productPlaceholderAssetKey: string;
  routeBlueprints: Readonly<Record<StorefrontRecipeBlueprintId, StoreTemplateRouteBlueprint>>;
}

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
  versions: readonly StoreTemplateVersionRecord[];
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

export const CURATED_FONT_IDS = [
  "archivo-narrow",
  "atkinson-hyperlegible",
  "fraunces",
  "ibm-plex-mono",
  "inter",
  "roboto-slab",
  "source-serif-4",
  "space-grotesk",
] as const;

export type CuratedFontId = (typeof CURATED_FONT_IDS)[number];

const CURATED_FONT_ID_SET: ReadonlySet<string> = new Set(CURATED_FONT_IDS);

export function isCuratedFontId(value: unknown): value is CuratedFontId {
  return typeof value === "string" && CURATED_FONT_ID_SET.has(value);
}

export const PUBLIC_BINDING_PATHS = [
  "store.name",
  "store.logo",
  "store.policyLinks",
  "store.socialLinks",
  "collection.id",
  "collection.handle",
  "collection.title",
  "collection.description",
  "collection.image",
  "collection.productCount",
  "collection.nextCursor",
  "product.id",
  "product.handle",
  "product.title",
  "product.description",
  "product.primaryImage",
  "product.images",
  "product.price",
  "product.compareAtPrice",
  "product.availability",
  "variant.id",
  "variant.title",
  "variant.price",
  "variant.compareAtPrice",
  "variant.availability",
  "cart.id",
  "cart.count",
  "cart.lines",
  "cart.subtotal",
  "cart.discounts",
  "cart.total",
  "cartLine.id",
  "cartLine.title",
  "cartLine.quantity",
  "cartLine.unitPrice",
  "cartLine.total",
  "search.query",
  "search.results",
  "search.nextCursor",
] as const;

export type PublicBindingPath = (typeof PUBLIC_BINDING_PATHS)[number];

const PUBLIC_BINDING_PATH_SET: ReadonlySet<string> = new Set(PUBLIC_BINDING_PATHS);

export function isPublicBindingPath(value: unknown): value is PublicBindingPath {
  return typeof value === "string" && PUBLIC_BINDING_PATH_SET.has(value);
}
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

export type CompiledBindingKind = "text" | "money" | "src" | "alt";

export interface CompiledBinding {
  id: string;
  targetId: string;
  kind: CompiledBindingKind;
  ref: PublicDataRef;
}

export type CompiledRepeatSource =
  | "collection.products"
  | "featured.products"
  | "related.products"
  | "search.results"
  | "cart.lines"
  | "product.images"
  | "product.variants";

export interface CompiledRepeat {
  scopeId: string;
  source: CompiledRepeatSource;
  itemKind: "product" | "cartLine" | "image" | "variant";
  keyPath: PublicBindingPath;
}

export type CompiledNode = CompiledTextNode | CompiledElementNode;

export interface CompiledTextNode {
  kind: "text";
  value: string;
}

export interface CompiledElementNode {
  kind: "element";
  id: string;
  tag: string;
  attributes: Record<string, string>;
  children: CompiledNode[];
  repeat?: CompiledRepeat;
  routeTarget?: RouteTarget;
  trustedSlotId?: string;
}

export interface RouteArtifact {
  /** Deterministic debug/cache representation. Runtime renderers consume tree, never this string. */
  html: string;
  tree: CompiledNode[];
  bindings: CompiledBinding[];
  css: string;
  requiredData: DataRequirement[];
  requiredCapabilities: RuntimeCapability[];
  interactions: InteractionManifestV1;
  trustedSlots: TrustedSlotManifest[];
}

export interface CheckoutRouteArtifact {
  /** Deterministic debug/cache representation. Runtime renderers consume decorativeTree. */
  decorativeHtml: string;
  decorativeTree: CompiledNode[];
  bindings: CompiledBinding[];
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
  /** Optional home curation; absent keeps the catalog's default featured order. */
  featuredProductIds?: string[];
  /** Optional content for the registry-owned visual host; absent renders its fallback. */
  visualLayer?: VisualLayerSpec;
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
