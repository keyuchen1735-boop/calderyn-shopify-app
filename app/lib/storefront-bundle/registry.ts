import type {
  AssetManifest,
  CuratedFontId,
  RecipeCardIdentity,
  RecipeCompositionIdentity,
  RecipeHeroIdentity,
  RecipeProtectedSlotPlacement,
  RecipeScrollIdentity,
  RouteCardPattern,
  RouteCompositionPattern,
  RouteHeroPattern,
  RouteScrollPattern,
  StoreTemplateId,
  RegisteredStoreTemplateId,
  StoreTemplateRouteBlueprint,
  StoreTemplateVersionRecord,
  StorefrontRecipeBlueprintId,
  StorefrontRouteId,
  VersionedStoreTemplate,
  VersionedStoreTemplateRegistry,
} from "./types";
import { ATELIER_GRID_ASSETS } from "../storefront-recipes/atelier-nine/assets";
import { ATELIER_ASSETS } from "../storefront-recipes/atelier/assets";
import { BROADCAST_PATCH_BAY_ASSETS } from "../storefront-recipes/broadcast-patch-bay/assets";
import { COMMONS_INDEX_ASSETS } from "../storefront-recipes/commons-index/assets";
import { COMPANION_FIELD_GUIDE_ASSETS } from "../storefront-recipes/companion-field-guide/assets";
import { CUSTOM_BENCH_ASSETS } from "../storefront-recipes/custom-bench/assets";
import { DAILY_PROTOCOL_ASSETS } from "../storefront-recipes/daily-protocol/assets";
import { DIAGNOSTIC_DECK_ASSETS } from "../storefront-recipes/diagnostic-deck/assets";
import { EMBER_ASSETS } from "../storefront-recipes/ember/assets";
import { FIZZ_ASSETS } from "../storefront-recipes/fizz/assets";
import { FORGE_ASSETS } from "../storefront-recipes/forge/assets";
import { GILT_ASSETS } from "../storefront-recipes/gilt/assets";
import { GLOW_ASSETS } from "../storefront-recipes/glow/assets";
import { HAVEN_ASSETS } from "../storefront-recipes/haven/assets";
import { LARDER_ASSETS } from "../storefront-recipes/larder/assets";
import { REP_REST_ASSETS } from "../storefront-recipes/rep-rest/assets";
import { ROAST_ASSETS } from "../storefront-recipes/roast/assets";
import { RITUAL_ALMANAC_ASSETS } from "../storefront-recipes/ritual-almanac/assets";
import { ROOM_MODES_ASSETS } from "../storefront-recipes/room-modes/assets";
import { SOFT_CHEMISTRY_ASSETS } from "../storefront-recipes/soft-chemistry/assets";
import { VOLT_ASSETS } from "../storefront-recipes/volt/assets";
import {
  RECIPE_CARD_TOPOLOGIES,
  RECIPE_COMPOSITION_FAMILIES,
  RECIPE_HERO_TREATMENTS,
  RECIPE_SCROLL_MODELS,
  ROUTE_CARD_PATTERNS,
  ROUTE_COMPOSITION_PATTERNS,
  ROUTE_HERO_PATTERNS,
  ROUTE_SCROLL_PATTERNS,
  isCuratedFontId,
} from "./types";

const ALL_ROUTES: readonly StorefrontRouteId[] = ["home", "collection", "product", "search", "cart", "checkout"];
const ALL_BLUEPRINTS: readonly StorefrontRecipeBlueprintId[] = ["shell", ...ALL_ROUTES];
const GENERIC_COMMERCE_TERMS = new Set(["shop", "product", "collection", "sale", "new", "premium", "gift"]);
const COMPOSITION_FAMILIES: ReadonlySet<string> = new Set(RECIPE_COMPOSITION_FAMILIES);
const HERO_TREATMENTS: ReadonlySet<string> = new Set(RECIPE_HERO_TREATMENTS);
const SCROLL_MODELS: ReadonlySet<string> = new Set(RECIPE_SCROLL_MODELS);
const CARD_TOPOLOGIES: ReadonlySet<string> = new Set(RECIPE_CARD_TOPOLOGIES);
const PROTECTED_SLOTS = new Set([
  "variantPicker", "addToCart", "productDescription", "cartLineControls", "cartSummary", "cartDrawer", "quickViewCommerce", "checkoutRoot", "bundleBuilder",
]);
const PROTECTED_HERO_ASSET_KEY = "hero";
function protectedHeroAssetKey(templateId: StoreTemplateId): string {
  return templateId === "larder" ? "hero-poster" : PROTECTED_HERO_ASSET_KEY;
}
function heroManifest(contentHash: string, byteSize: number): AssetManifest {
  return { entries: [{ key: "hero", contentHash, mediaType: "image/webp", byteSize }] };
}

function repeatManifest(manifest: AssetManifest, count: number): readonly AssetManifest[] {
  return Array.from({ length: count }, () => manifest);
}

const softChemistryLegacyHero = heroManifest("4639c3cfe144d901162c2ede0053cd6174e26379460e3d63a3bef64f286f482f", 40456);
const softChemistryLegacyFull = {
  entries: [...softChemistryLegacyHero.entries, ...SOFT_CHEMISTRY_ASSETS.entries.filter(({ key }) => key !== "hero")],
} satisfies AssetManifest;
const VERSIONED_ASSET_MANIFESTS_BY_TEMPLATE_ID = {
  "custom-bench": [...repeatManifest(heroManifest("f6f25c15de46bf6dd431ae685202f90fbbc3ba00e8051f6a6f4afaa8b89cdde9", 132568), 5), CUSTOM_BENCH_ASSETS, CUSTOM_BENCH_ASSETS, CUSTOM_BENCH_ASSETS, CUSTOM_BENCH_ASSETS, CUSTOM_BENCH_ASSETS, CUSTOM_BENCH_ASSETS, CUSTOM_BENCH_ASSETS],
  "commons-index": [...repeatManifest(heroManifest("9201028ef1da24dd4318d0dafd8b4e18f32d16e12ba921c5ded28765b0cbaca1", 130446), 4), COMMONS_INDEX_ASSETS, COMMONS_INDEX_ASSETS, COMMONS_INDEX_ASSETS, COMMONS_INDEX_ASSETS, COMMONS_INDEX_ASSETS, COMMONS_INDEX_ASSETS, COMMONS_INDEX_ASSETS],
  "soft-chemistry": [...repeatManifest(softChemistryLegacyHero, 3), ...repeatManifest(softChemistryLegacyFull, 4), SOFT_CHEMISTRY_ASSETS, SOFT_CHEMISTRY_ASSETS, SOFT_CHEMISTRY_ASSETS, SOFT_CHEMISTRY_ASSETS, SOFT_CHEMISTRY_ASSETS, SOFT_CHEMISTRY_ASSETS, SOFT_CHEMISTRY_ASSETS],
  "companion-field-guide": [...repeatManifest(heroManifest("305b7c4a9f43578032dba1e95a63869d9e17b370585c24438b7b963aa0a9a2d6", 158522), 3), COMPANION_FIELD_GUIDE_ASSETS, COMPANION_FIELD_GUIDE_ASSETS, COMPANION_FIELD_GUIDE_ASSETS, COMPANION_FIELD_GUIDE_ASSETS, COMPANION_FIELD_GUIDE_ASSETS, COMPANION_FIELD_GUIDE_ASSETS, COMPANION_FIELD_GUIDE_ASSETS],
  "daily-protocol": [...repeatManifest(heroManifest("798fb222ba0b6975c3f83d7d95f6640227f781b2e4582f758cc712a0f45a8054", 81984), 3), DAILY_PROTOCOL_ASSETS, DAILY_PROTOCOL_ASSETS, DAILY_PROTOCOL_ASSETS, DAILY_PROTOCOL_ASSETS, DAILY_PROTOCOL_ASSETS, DAILY_PROTOCOL_ASSETS],
  "room-modes": [...repeatManifest(heroManifest("ed779ae096effacc6af8a58f5ab55b79faad5ae2b3b5fba892b796e310586d30", 80050), 3), ROOM_MODES_ASSETS, ROOM_MODES_ASSETS, ROOM_MODES_ASSETS, ROOM_MODES_ASSETS, ROOM_MODES_ASSETS, ROOM_MODES_ASSETS, ROOM_MODES_ASSETS],
  "rep-rest": [...repeatManifest(heroManifest("b404cf72b60022837096e1e8b02d539b5369a9ff09d4bda742378b7aae71d9c1", 170844), 3), REP_REST_ASSETS, REP_REST_ASSETS, REP_REST_ASSETS, REP_REST_ASSETS, REP_REST_ASSETS, REP_REST_ASSETS],
  "diagnostic-deck": [...repeatManifest(heroManifest("dca1f96a14f60dcc2b1305f84ac97b480f8007a25709ac9995eee71ac8e2db9e", 101094), 3), DIAGNOSTIC_DECK_ASSETS, DIAGNOSTIC_DECK_ASSETS, DIAGNOSTIC_DECK_ASSETS, DIAGNOSTIC_DECK_ASSETS, DIAGNOSTIC_DECK_ASSETS, DIAGNOSTIC_DECK_ASSETS, DIAGNOSTIC_DECK_ASSETS],
  "ritual-almanac": [...repeatManifest(heroManifest("747c24090ce37d341af9d22a7057f5830c26dc74181da0d82bb5aa07ffafe8f8", 242494), 3), RITUAL_ALMANAC_ASSETS, RITUAL_ALMANAC_ASSETS, RITUAL_ALMANAC_ASSETS, RITUAL_ALMANAC_ASSETS, RITUAL_ALMANAC_ASSETS, RITUAL_ALMANAC_ASSETS],
  "broadcast-patch-bay": [...repeatManifest(heroManifest("c95d86839d3b7efea39f439452011aaad78e4519e9928890246f67b0bf9f5363", 78150), 4), BROADCAST_PATCH_BAY_ASSETS, BROADCAST_PATCH_BAY_ASSETS, BROADCAST_PATCH_BAY_ASSETS, BROADCAST_PATCH_BAY_ASSETS, BROADCAST_PATCH_BAY_ASSETS, BROADCAST_PATCH_BAY_ASSETS, BROADCAST_PATCH_BAY_ASSETS],
  "atelier-nine": repeatManifest(ATELIER_GRID_ASSETS, 6),
  larder: [LARDER_ASSETS],
  volt: [VOLT_ASSETS, VOLT_ASSETS, VOLT_ASSETS],
  atelier: [ATELIER_ASSETS, ATELIER_ASSETS, ATELIER_ASSETS],
  gilt: [GILT_ASSETS, GILT_ASSETS, GILT_ASSETS],
  ember: [EMBER_ASSETS, EMBER_ASSETS, EMBER_ASSETS],
  roast: [ROAST_ASSETS, ROAST_ASSETS, ROAST_ASSETS],
  fizz: [FIZZ_ASSETS, FIZZ_ASSETS, FIZZ_ASSETS],
  forge: [FORGE_ASSETS, FORGE_ASSETS, FORGE_ASSETS, FORGE_ASSETS],
  haven: [HAVEN_ASSETS, HAVEN_ASSETS, HAVEN_ASSETS],
  glow: [GLOW_ASSETS, GLOW_ASSETS, GLOW_ASSETS],
} satisfies Readonly<Record<RegisteredStoreTemplateId, readonly AssetManifest[]>>;

const TEXT_SLOTS_BY_TEMPLATE_ID = {
  "custom-bench": ["heroEyebrow", "heroTitle", "heroBody", "ctaLabel"],
  "commons-index": ["heroEyebrow", "heroTitle", "heroBody", "ctaLabel"],
  "soft-chemistry": ["heroEyebrow", "heroTitle", "heroBody", "ctaLabel"],
  "companion-field-guide": ["heroEyebrow", "heroTitle", "heroBody", "sectionHeading"],
  "daily-protocol": ["heroEyebrow", "heroTitle"],
  "room-modes": ["heroEyebrow", "heroTitle", "heroBody", "ctaLabel"],
  "rep-rest": ["heroTitle", "ctaLabel"],
  "diagnostic-deck": ["heroEyebrow", "heroTitle", "heroBody", "ctaLabel"],
  "ritual-almanac": ["heroEyebrow", "heroTitle", "heroBody", "sectionHeading", "ctaLabel"],
  "broadcast-patch-bay": ["heroEyebrow", "heroTitle", "heroBody", "sectionHeading", "ctaLabel"],
  "atelier-nine": ["announcement", "heroTitle", "heroBody", "ctaLabel"],
  larder: ["heroTitle", "heroBody", "ctaLabel"],
  volt: ["heroTitle", "heroBody", "ctaLabel"],
  atelier: ["heroTitle", "ctaLabel"],
  gilt: ["heroTitle", "ctaLabel"],
  ember: ["heroTitle", "heroBody", "ctaLabel"],
  roast: ["heroTitle", "heroBody", "ctaLabel"],
  fizz: ["heroTitle", "heroBody", "ctaLabel"],
  forge: ["heroTitle", "heroBody", "ctaLabel"],
  haven: ["heroTitle", "heroBody", "ctaLabel"],
  glow: ["heroTitle", "heroBody", "ctaLabel"],
} as const satisfies Readonly<Record<RegisteredStoreTemplateId, readonly string[]>>;

const DEFAULT_OVERRIDE_SURFACE = {
  designTokens: ["color", "typography", "spacing", "radius", "motion"],
  optionalRegions: ["announcement", "editorialStory", "socialProof", "newsletter"],
  reorderableRegions: ["featuredCollection", "editorialStory", "socialProof", "newsletter"],
} as const;

interface RecipeSemanticSignature {
  compositionFamily: RecipeCompositionIdentity;
  heroTreatment: RecipeHeroIdentity;
  scrollModel: RecipeScrollIdentity;
  displayFontId: CuratedFontId;
  bodyFontId: CuratedFontId;
  iconRules: readonly string[];
  cardTopology: RecipeCardIdentity;
  signatureInteractions: readonly string[];
  forbiddenGenericStructures: readonly string[];
}

interface RouteSemanticLayer {
  compositionPattern: RouteCompositionPattern;
  heroPattern: RouteHeroPattern;
  scrollPattern: RouteScrollPattern;
  cardPattern: RouteCardPattern;
  iconRules: readonly string[];
  signatureInteractions: readonly string[];
  forbiddenGenericStructures: readonly string[];
}

const ROUTE_SEMANTIC_LAYERS: Readonly<Record<StorefrontRecipeBlueprintId, RouteSemanticLayer>> = {
  shell: {
    compositionPattern: ROUTE_COMPOSITION_PATTERNS.shell,
    heroPattern: ROUTE_HERO_PATTERNS.shell,
    scrollPattern: ROUTE_SCROLL_PATTERNS.shell,
    cardPattern: ROUTE_CARD_PATTERNS.shell,
    iconRules: ["persistent navigation marks", "cart status indicators"],
    signatureInteractions: ["navigation state choreography", "cart drawer focus handoff"],
    forbiddenGenericStructures: ["route hero content inside the shell", "route-owned commerce forms in global chrome"],
  },
  home: {
    compositionPattern: ROUTE_COMPOSITION_PATTERNS.home,
    heroPattern: ROUTE_HERO_PATTERNS.home,
    scrollPattern: ROUTE_SCROLL_PATTERNS.home,
    cardPattern: ROUTE_CARD_PATTERNS.home,
    iconRules: ["brand-story wayfinding marks", "featured collection cues"],
    signatureInteractions: ["hero-to-collection narrative handoff", "featured story module reveal"],
    forbiddenGenericStructures: ["generic centered hero plus three cards", "collection filters in the brand entry sequence"],
  },
  collection: {
    compositionPattern: ROUTE_COMPOSITION_PATTERNS.collection,
    heroPattern: ROUTE_HERO_PATTERNS.collection,
    scrollPattern: ROUTE_SCROLL_PATTERNS.collection,
    cardPattern: ROUTE_CARD_PATTERNS.collection,
    iconRules: ["facet state symbols", "product density controls"],
    signatureInteractions: ["sticky facet result synchronization", "collection density switching"],
    forbiddenGenericStructures: ["editorial hero obscuring browse controls", "product grids without collection context"],
  },
  product: {
    compositionPattern: ROUTE_COMPOSITION_PATTERNS.product,
    heroPattern: ROUTE_HERO_PATTERNS.product,
    scrollPattern: ROUTE_SCROLL_PATTERNS.product,
    cardPattern: ROUTE_CARD_PATTERNS.product,
    iconRules: ["media position markers", "variant availability signals"],
    signatureInteractions: ["media-to-variant synchronization", "sticky purchase detail progression"],
    forbiddenGenericStructures: ["detached add-to-cart controls", "generic specification accordion stack"],
  },
  search: {
    compositionPattern: ROUTE_COMPOSITION_PATTERNS.search,
    heroPattern: ROUTE_HERO_PATTERNS.search,
    scrollPattern: ROUTE_SCROLL_PATTERNS.search,
    cardPattern: ROUTE_CARD_PATTERNS.search,
    iconRules: ["query refinement marks", "result relevance signals"],
    signatureInteractions: ["query refinement result handoff", "ranked result state transition"],
    forbiddenGenericStructures: ["marketing hero above search feedback", "results without query or empty-state context"],
  },
  cart: {
    compositionPattern: ROUTE_COMPOSITION_PATTERNS.cart,
    heroPattern: ROUTE_HERO_PATTERNS.cart,
    scrollPattern: ROUTE_SCROLL_PATTERNS.cart,
    cardPattern: ROUTE_CARD_PATTERNS.cart,
    iconRules: ["line quantity controls", "discount and subtotal status marks"],
    signatureInteractions: ["line update summary synchronization", "checkout readiness transition"],
    forbiddenGenericStructures: ["decorative content between lines and totals", "untrusted replacement cart controls"],
  },
  checkout: {
    compositionPattern: ROUTE_COMPOSITION_PATTERNS.checkout,
    heroPattern: ROUTE_HERO_PATTERNS.checkout,
    scrollPattern: ROUTE_SCROLL_PATTERNS.checkout,
    cardPattern: ROUTE_CARD_PATTERNS.checkout,
    iconRules: ["checkout progress marks", "trust and fulfillment indicators"],
    signatureInteractions: ["trusted checkout step progression", "order summary disclosure"],
    forbiddenGenericStructures: ["merchant-authored payment controls", "promotional detours inside checkout flow"],
  },
};

const RECIPE_SEMANTIC_SIGNATURES: Readonly<Record<RegisteredStoreTemplateId, RecipeSemanticSignature>> = {
  "custom-bench": {
    compositionFamily: "workshop-configurator",
    heroTreatment: "configurator-workbench",
    scrollModel: "guided-steps",
    displayFontId: "barlow-condensed",
    bodyFontId: "manrope",
    iconRules: ["square workshop glyphs", "dimension-line indicators"],
    cardTopology: "material-specimen-grid",
    signatureInteractions: ["stepwise customization", "material swatch preview"],
    forbiddenGenericStructures: ["centered lifestyle hero", "undifferentiated product card grid"],
  },
  "commons-index": {
    compositionFamily: "cooperative-directory",
    heroTreatment: "impact-ledger-intro",
    scrollModel: "indexed-ledger",
    displayFontId: "source-fraunces",
    bodyFontId: "dm-mono",
    iconRules: ["civic index marks", "material provenance stamps"],
    cardTopology: "provenance-records",
    signatureInteractions: ["impact ledger expansion", "refill loop tracing"],
    forbiddenGenericStructures: ["floating gradient hero", "generic sustainability badges"],
  },
  "soft-chemistry": {
    compositionFamily: "clinical-editorial",
    heroTreatment: "ingredient-routine-hero",
    scrollModel: "soft-reveal",
    displayFontId: "cormorant-garamond",
    bodyFontId: "manrope",
    iconRules: ["fine ingredient diagrams", "quiet clinical symbols"],
    cardTopology: "ingredient-dossiers",
    signatureInteractions: ["routine builder", "skin concern filtering"],
    forbiddenGenericStructures: ["beauty collage hero", "rounded pastel card wall"],
  },
  "companion-field-guide": {
    compositionFamily: "field-guide",
    heroTreatment: "pet-profile-hero",
    scrollModel: "chaptered-guide",
    displayFontId: "newsreader",
    bodyFontId: "manrope",
    iconRules: ["species field marks", "dosage fact symbols"],
    cardTopology: "field-notes",
    signatureInteractions: ["pet profile switching", "life stage filtering"],
    forbiddenGenericStructures: ["mascot-first hero", "generic pet tile grid"],
  },
  "daily-protocol": {
    compositionFamily: "protocol-ledger",
    heroTreatment: "time-of-day-protocol",
    scrollModel: "routine-timeline",
    displayFontId: "manrope",
    bodyFontId: "dm-mono",
    iconRules: ["time block markers", "dosage data glyphs"],
    cardTopology: "protocol-stacks",
    signatureInteractions: ["protocol stack assembly", "time of day switching"],
    forbiddenGenericStructures: ["wellness stock-photo hero", "generic benefit icon row"],
  },
  "room-modes": {
    compositionFamily: "spatial-scenes",
    heroTreatment: "room-mode-scene",
    scrollModel: "spatial-snap",
    displayFontId: "syne",
    bodyFontId: "dm-mono",
    iconRules: ["architectural plan symbols", "device protocol marks"],
    cardTopology: "scene-panels",
    signatureInteractions: ["room mode switching", "spatial scene transitions"],
    forbiddenGenericStructures: ["centered smart-home hero", "feature checklist cards"],
  },
  "rep-rest": {
    compositionFamily: "split-performance",
    heroTreatment: "training-recovery-split",
    scrollModel: "sticky-workout",
    displayFontId: "oswald",
    bodyFontId: "manrope",
    iconRules: ["training interval marks", "recovery status glyphs"],
    cardTopology: "comparison-rails",
    signatureInteractions: ["training recovery toggle", "sticky workout chapters"],
    forbiddenGenericStructures: ["athlete stock-photo hero", "uniform equipment grid"],
  },
  "diagnostic-deck": {
    compositionFamily: "diagnostic-terminal",
    heroTreatment: "grade-diagnostic-hero",
    scrollModel: "deck-snap",
    displayFontId: "archivo-black",
    bodyFontId: "dm-mono",
    iconRules: ["terminal condition marks", "warranty status glyphs"],
    cardTopology: "diagnostic-cards",
    signatureInteractions: ["grade evidence reveal", "spec deck comparison"],
    forbiddenGenericStructures: ["floating device hero", "marketplace listing grid"],
  },
  "ritual-almanac": {
    compositionFamily: "editorial-almanac",
    heroTreatment: "ritual-time-hero",
    scrollModel: "almanac-chapters",
    displayFontId: "young-serif",
    bodyFontId: "manrope",
    iconRules: ["time ritual marks", "flavor note symbols"],
    cardTopology: "ritual-entries",
    signatureInteractions: ["ritual time browsing", "subscription cadence selection"],
    forbiddenGenericStructures: ["beverage splash hero", "generic flavor card grid"],
  },
  "broadcast-patch-bay": {
    compositionFamily: "signal-patch-bay",
    heroTreatment: "rig-signal-chain",
    scrollModel: "modular-patching",
    displayFontId: "chakra-petch",
    bodyFontId: "dm-mono",
    iconRules: ["signal path glyphs", "compatibility port marks"],
    cardTopology: "signal-modules",
    signatureInteractions: ["signal chain assembly", "rig mode switching"],
    forbiddenGenericStructures: ["neon gaming collage", "generic gear carousel"],
  },
  "atelier-nine": {
    compositionFamily: "asymmetric-magazine",
    heroTreatment: "editorial-grid-hero",
    scrollModel: "restrained-editorial",
    displayFontId: "archivo-narrow",
    bodyFontId: "source-serif-4",
    iconRules: ["thin editorial arrows", "restrained utility marks"],
    cardTopology: "magazine-grid",
    signatureInteractions: ["asymmetric editorial reveal", "restrained image focus"],
    forbiddenGenericStructures: ["centered luxury hero", "rounded product card grid"],
  },
  larder: {
    compositionFamily: "working-pantry",
    heroTreatment: "pantry-table-hero",
    scrollModel: "pantry-rhythm",
    displayFontId: "fraunces",
    bodyFontId: "manrope",
    iconRules: ["hand-cut shelf marks", "tomato olive pantry symbols"],
    cardTopology: "pantry-shelves",
    signatureInteractions: ["six-place pantry building", "shelf replenishment browsing"],
    forbiddenGenericStructures: ["generic grocery card wall", "fabricated subscription selector"],
  },
  volt: { compositionFamily: "system-architecture", heroTreatment: "cinematic-rim-hero", scrollModel: "system-sequence", displayFontId: "space-grotesk", bodyFontId: "ibm-plex-mono", iconRules: ["precision channel marks", "battery line diagrams"], cardTopology: "spec-modules", signatureInteractions: ["live product comparison", "three-piece ecosystem building"], forbiddenGenericStructures: ["generic electronics carousel", "unsupported compatibility claims"] },
  atelier: { compositionFamily: "fit-laboratory", heroTreatment: "fabric-study-hero", scrollModel: "fit-study", displayFontId: "space-grotesk", bodyFontId: "newsreader", iconRules: ["measured garment marks", "restrained fit notation"], cardTopology: "garment-studies", signatureInteractions: ["fit preference guidance", "live variant confirmation"], forbiddenGenericStructures: ["magazine collage grid", "invented size recommendation"] },
  gilt: { compositionFamily: "object-ceremony", heroTreatment: "jewelry-ceremony-hero", scrollModel: "intimate-ceremony", displayFontId: "cormorant-garamond", bodyFontId: "manrope", iconRules: ["fine gold hallmarks", "circular object indices"], cardTopology: "object-vignettes", signatureInteractions: ["protected engraving handoff", "recipient gifting flow"], forbiddenGenericStructures: ["generic luxury mosaic", "unprotected personalization form"] },
  ember: { compositionFamily: "tasting-counter", heroTreatment: "heat-spectrum-hero", scrollModel: "heat-tasting", displayFontId: "archivo-black", bodyFontId: "barlow-condensed", iconRules: ["pepper scale marks", "raw tasting stamps"], cardTopology: "tasting-flights", signatureInteractions: ["heat level selection", "tasting flight assembly"], forbiddenGenericStructures: ["generic snack grid", "fabricated heat claims"] },
  roast: { compositionFamily: "origin-notebook", heroTreatment: "origin-brew-hero", scrollModel: "brew-notebook", displayFontId: "archivo-black", bodyFontId: "dm-mono", iconRules: ["brew ratio marks", "origin plot symbols"], cardTopology: "origin-cards", signatureInteractions: ["brew method guidance", "subscription cadence selection"], forbiddenGenericStructures: ["coffee splash hero", "invented origin notes"] },
  fizz: { compositionFamily: "flavor-playground", heroTreatment: "flavor-play-hero", scrollModel: "flavor-modules", displayFontId: "space-grotesk", bodyFontId: "inter", iconRules: ["rounded fruit slices", "bubble cluster marks"], cardTopology: "flavor-tiles", signatureInteractions: ["flavor personality guidance", "variety pack building"], forbiddenGenericStructures: ["generic beverage rainbow", "unsupported functional claims"] },
  forge: { compositionFamily: "jobsite-blueprint", heroTreatment: "exploded-tool-hero", scrollModel: "blueprint-flow", displayFontId: "oswald", bodyFontId: "dm-mono", iconRules: ["numbered drawing callouts", "dimension ticks"], cardTopology: "tool-diagrams", signatureInteractions: ["compatibility filtering", "project kit assembly"], forbiddenGenericStructures: ["generic hardware aisle", "invented compatibility data"] },
  haven: { compositionFamily: "spatial-studies", heroTreatment: "material-room-hero", scrollModel: "spatial-quiet", displayFontId: "fraunces", bodyFontId: "inter", iconRules: ["quiet floor plan marks", "joinery lines"], cardTopology: "material-panels", signatureInteractions: ["room fit checking", "swatch ordering path"], forbiddenGenericStructures: ["generic furniture collage", "fake augmented reality controls"] },
  glow: { compositionFamily: "clinical-evidence", heroTreatment: "clinical-liquid-hero", scrollModel: "clinical-proof", displayFontId: "source-serif-4", bodyFontId: "atkinson-hyperlegible", iconRules: ["formula index marks", "quiet laboratory rules"], cardTopology: "evidence-cards", signatureInteractions: ["skin preference routine", "ingredient evidence reveal"], forbiddenGenericStructures: ["generic beauty collage", "unsupported clinical claims"] },
};

function protectedSlotsFor(blueprint: StorefrontRecipeBlueprintId, templateId: RegisteredStoreTemplateId): RecipeProtectedSlotPlacement[] {
  switch (blueprint) {
    case "shell": return [{ slot: "cartDrawer", region: "shell.utility" }];
    case "home": return templateId === "larder"
      ? [{ slot: "bundleBuilder", region: "home.pantry-box" }, { slot: "quickViewCommerce", region: "home.featured" }]
      : templateId === "volt"
        ? [{ slot: "bundleBuilder", region: "home.ecosystem-builder" }, { slot: "quickViewCommerce", region: "home.featured" }]
        : [{ slot: "quickViewCommerce", region: "home.featured" }];
    case "collection": return [
      { slot: "quickViewCommerce", region: "collection.results" },
      { slot: "productDescription", region: "collection.results" },
    ];
    case "product": return [
      { slot: "variantPicker", region: "product.purchase" },
      { slot: "addToCart", region: "product.purchase" },
      { slot: "productDescription", region: "product.purchase" },
    ];
    case "search": return [{ slot: "quickViewCommerce", region: "search.results" }];
    case "cart": return [
      { slot: "cartLineControls", region: "cart.lines" },
      { slot: "cartSummary", region: "cart.summary" },
    ];
    case "checkout": return [{ slot: "checkoutRoot", region: "checkout.platform" }];
  }
}

function routeSemanticValue<Base extends string, Pattern extends string, Route extends string>(
  base: Base,
  pattern: Pattern,
  route: Route,
): `${Base}.${Pattern}.${Route}` {
  return `${base}.${pattern}.${route}`;
}

function recipe(
  value: Omit<VersionedStoreTemplate, "id" | "activeVersion" | "versions" | "routeCapabilities" | "overrideSurface" | "previewSrc"> & { id: RegisteredStoreTemplateId },
  activeVersion = 1,
): VersionedStoreTemplate {
  const blueprintRoot = `app/lib/storefront-recipes/${value.id}/bundle.ts`;
  const signature = RECIPE_SEMANTIC_SIGNATURES[value.id];
  const blueprint = (blueprintId: StorefrontRecipeBlueprintId): StoreTemplateRouteBlueprint => {
    const routeLayer = ROUTE_SEMANTIC_LAYERS[blueprintId];
    return {
      sourceRef: `${blueprintRoot}#${blueprintId}`,
      compositionFamily: routeSemanticValue(signature.compositionFamily, routeLayer.compositionPattern, blueprintId),
      heroTreatment: routeSemanticValue(signature.heroTreatment, routeLayer.heroPattern, blueprintId),
      scrollModel: routeSemanticValue(signature.scrollModel, routeLayer.scrollPattern, blueprintId),
      displayFontId: signature.displayFontId,
      bodyFontId: signature.bodyFontId,
      iconRules: [...signature.iconRules, ...routeLayer.iconRules],
      cardTopology: routeSemanticValue(signature.cardTopology, routeLayer.cardPattern, blueprintId),
      protectedSlotPlacement: protectedSlotsFor(blueprintId, value.id),
      signatureInteractions: [...signature.signatureInteractions, ...routeLayer.signatureInteractions],
      forbiddenGenericStructures: [
        ...signature.forbiddenGenericStructures,
        ...routeLayer.forbiddenGenericStructures,
      ],
    };
  };
  const routeBlueprints = {
    shell: blueprint("shell"),
    home: blueprint("home"),
    collection: blueprint("collection"),
    product: blueprint("product"),
    search: blueprint("search"),
    cart: blueprint("cart"),
    checkout: blueprint("checkout"),
  } satisfies Record<StorefrontRecipeBlueprintId, StoreTemplateRouteBlueprint>;
  const version = (templateVersion: number): StoreTemplateVersionRecord => {
    const assets = VERSIONED_ASSET_MANIFESTS_BY_TEMPLATE_ID[value.id][templateVersion - 1];
    if (!assets) throw new Error(`Missing recipe assets for ${value.id}@${templateVersion}`);
    return {
      templateVersion,
      assets,
      baselineArtifact:
        value.id === "atelier-nine"
          ? "public/atelier-grid/index.html"
          : `docs/superpowers/prototypes/storefront-recipes/${value.id}.html`,
      screenshots: {
        desktop: `public/storefront-recipes/${value.id}/baselines/v${templateVersion}-desktop.webp`,
        mobile: `public/storefront-recipes/${value.id}/baselines/v${templateVersion}-mobile.webp`,
      },
      visualLayer: {
        slotId: `visual:${value.id}:v${templateVersion}`,
        fallbackAssetKey: protectedHeroAssetKey(value.id),
        placement: "hero-background",
        pointerEvents: "none",
      },
      productPlaceholderAssetKey: protectedHeroAssetKey(value.id),
      routeBlueprints,
    };
  };
  return {
    ...value,
    activeVersion,
    versions: Array.from({ length: activeVersion }, (_, index) => version(index + 1)),
    routeCapabilities: ALL_ROUTES,
    overrideSurface: { ...DEFAULT_OVERRIDE_SURFACE, textSlots: TEXT_SLOTS_BY_TEMPLATE_ID[value.id] },
    previewSrc: `/template-previews/${value.id}.webp`,
  };
}

const RECIPES: readonly VersionedStoreTemplate[] = [
  recipe({
    id: "custom-bench",
    name: "Custom Bench",
    niche: "Personalized and custom products",
    descriptor: "Workshop configurator / material-led / personal",
    aliases: ["workshop configurator"],
    strongPhrases: ["personalized products", "custom products", "engraved gifts", "personalized gifts", "made to order"],
    promptTerms: ["personalized", "customized", "engraved", "monogrammed", "bespoke", "configurator"],
    catalogTerms: ["engraving", "engraved", "monogram", "personalization", "made to order", "customizable"],
    legacyVibe: "minimal",
    generationInstructions: "Use a tactile workshop configurator with material swatches, engraved previews, and stepwise customization.",
  }, 12),
  recipe({
    id: "commons-index",
    name: "Commons Index",
    niche: "Sustainable micro-niches",
    descriptor: "Cooperative directory / impact-led / earthy",
    aliases: ["impact ledger"],
    strongPhrases: ["sustainable refill", "refill shop", "low waste", "zero waste", "material provenance"],
    promptTerms: ["sustainable", "refill", "reusable", "compostable", "circular", "provenance"],
    catalogTerms: ["refill", "reusable", "compostable", "zero waste", "low waste", "plastic free"],
    legacyVibe: "minimal",
    generationInstructions: "Use a cooperative directory, impact ledger, refill loops, and material provenance with civic editorial typography.",
  }, 11),
  recipe({
    id: "soft-chemistry",
    name: "Soft Chemistry",
    niche: "Beauty and clean personal care",
    descriptor: "Clinical softness / ingredient-led / refined",
    aliases: ["clean beauty lab"],
    strongPhrases: ["clean skincare", "clean skin care", "sensitive skin", "clean personal care", "ingredient transparency"],
    promptTerms: ["skincare", "beauty", "serum", "clean", "sensitive", "ingredient"],
    catalogTerms: ["skincare", "skin care", "serum", "clean beauty", "sensitive skin", "moisturizer"],
    legacyVibe: "minimal",
    generationInstructions: "Use clinical softness, ingredient transparency, routine building, and skin-concern filters.",
  }, 14),
  recipe({
    id: "companion-field-guide",
    name: "Companion Field Guide",
    niche: "Pet products and specialty pet health",
    descriptor: "Field guide / pet profiles / friendly facts",
    aliases: ["pet field guide"],
    strongPhrases: ["specialty pet health", "pet health", "pet wellness", "dog health", "cat health"],
    promptTerms: ["pet", "canine", "feline", "dog", "cat", "supplement"],
    catalogTerms: ["pet supplement", "pet health", "pet wellness", "dog health", "cat wellness", "pet care", "canine"],
    legacyVibe: "warm",
    generationInstructions: "Use field-guide navigation, pet profiles, species filters, dosage facts, and friendly slab typography.",
  }, 10),
  recipe({
    id: "daily-protocol",
    name: "Daily Protocol",
    niche: "Health and wellness products",
    descriptor: "Routine ledger / disciplined / evidence-led",
    aliases: ["routine ledger"],
    strongPhrases: ["daily wellness", "health and wellness", "wellness routine", "protocol stack", "daily supplements"],
    promptTerms: ["wellness", "routine", "protocol", "vitamin", "supplements", "holistic"],
    catalogTerms: ["wellness", "vitamin", "supplements", "daily routine", "protocol", "recovery"],
    legacyVibe: "minimal",
    generationInstructions: "Use a routine ledger, time-of-day shopping, protocol stacks, and mono dosage facts.",
  }, 9),
  recipe({
    id: "room-modes",
    name: "Room Modes",
    niche: "Smart home and lifestyle decor",
    descriptor: "Scene browsing / spatial / technical",
    aliases: ["scene based home"],
    strongPhrases: ["smart home", "lifestyle decor", "room scene", "connected home", "home automation"],
    promptTerms: ["smart", "home", "decor", "lighting", "connected", "automation"],
    catalogTerms: ["smart home", "smart lighting", "home decor", "matter compatible", "home automation", "room scene"],
    legacyVibe: "minimal",
    generationInstructions: "Use scene-based browsing, room modes, device protocol facts, and architectural spatial transitions.",
  }, 10),
  recipe({
    id: "rep-rest",
    name: "Rep / Rest",
    niche: "Athleisure and home fitness equipment",
    descriptor: "Training split / performance-led / kinetic",
    aliases: ["rep and rest"],
    strongPhrases: ["home fitness", "fitness equipment", "training recovery", "workout gear", "athleisure store"],
    promptTerms: ["fitness", "athleisure", "training", "workout", "equipment", "recovery"],
    catalogTerms: ["fitness equipment", "workout gear", "training", "athleisure", "home gym", "recovery gear"],
    legacyVibe: "bold",
    generationInstructions: "Use split training and recovery journeys, high-contrast performance type, and sticky workout storytelling.",
  }, 9),
  recipe({
    id: "diagnostic-deck",
    name: "Diagnostic Deck",
    niche: "Resale and refurbished electronics",
    descriptor: "Diagnostic cards / grades / warranty evidence",
    aliases: ["refurb deck"],
    strongPhrases: ["refurbished electronics", "certified refurbished", "resale electronics", "device grading", "warranty tested"],
    promptTerms: ["refurbished", "resale", "electronics", "warranty", "graded", "tested"],
    catalogTerms: ["refurbished", "certified refurbished", "electronics", "device grade", "warranty", "open box"],
    legacyVibe: "bold",
    generationInstructions: "Use diagnostic cards, grade and warranty evidence, spec comparisons, and terminal inventory signals.",
  }, 10),
  recipe({
    id: "ritual-almanac",
    name: "Ritual Almanac",
    niche: "Functional foods and specialty beverages",
    descriptor: "Ritual browsing / editorial / sensory",
    aliases: ["flavor almanac"],
    strongPhrases: ["functional foods", "specialty beverages", "functional beverage", "daily ritual", "adaptogenic drinks"],
    promptTerms: ["functional", "beverage", "ritual", "adaptogen", "tea", "coffee"],
    catalogTerms: ["functional food", "functional beverage", "adaptogen", "specialty tea", "specialty coffee", "ritual"],
    legacyVibe: "warm",
    generationInstructions: "Use time-and-ritual browsing, flavor and sourcing stories, and subscription cadence.",
  }, 9),
  recipe({
    id: "broadcast-patch-bay",
    name: "Broadcast Patch Bay",
    niche: "Gaming and creator economy products",
    descriptor: "Signal chain / modular / broadcast neon",
    aliases: ["creator patch bay"],
    strongPhrases: ["creator economy", "gaming setup", "streaming gear", "creator rig", "broadcast equipment"],
    promptTerms: ["gaming", "creator", "streaming", "broadcast", "rig", "microphone"],
    catalogTerms: ["gaming gear", "streaming gear", "creator tools", "broadcast", "microphone", "capture card"],
    legacyVibe: "bold",
    generationInstructions: "Use a modular signal-chain builder, rig modes, compatibility graphs, and neon broadcast UI.",
  }, 11),
  recipe({
    id: "atelier-nine",
    name: "Atelier Grid",
    niche: "Editorial fashion, beauty, jewelry, and quiet luxury",
    descriptor: "Editorial / restrained / fashion-led",
    aliases: ["atelier nine"],
    strongPhrases: ["quiet luxury", "editorial fashion", "jewelry label", "fashion studio", "luxury skincare"],
    promptTerms: ["editorial", "fashion", "jewelry", "luxury", "apparel", "studio"],
    catalogTerms: ["fashion", "jewelry", "apparel", "quiet luxury", "fine jewelry", "designer clothing"],
    legacyVibe: "minimal",
    generationInstructions: "Use a warm-white asymmetric magazine grid, condensed display type, thin rules, vermilion accents, and restrained motion.",
  }, 6),
  recipe({
    id: "larder",
    name: "Larder",
    niche: "Grocery and pantry staples",
    descriptor: "Working pantry / replenishment-led / tactile",
    aliases: ["working pantry"],
    strongPhrases: ["pantry staples", "subscription pantry", "grocery pantry", "build a pantry box"],
    promptTerms: ["pantry", "grocery", "staples", "provisions", "replenishment", "jarred"],
    catalogTerms: ["pantry staples", "grocery", "provisions", "subscription box", "condiments", "snacks"],
    legacyVibe: "warm",
    generationInstructions: "Use a tactile working pantry, live shelf browsing, and a protected six-place box builder with warm paper, tomato, and olive tones.",
  }),
  recipe({ id: "volt", name: "Volt", niche: "Wireless audio and smart electronics", descriptor: "Cinematic system architecture / technical / dark", aliases: ["volt audio system"], strongPhrases: ["wireless audio ecosystem", "smart audio system", "connected speakers"], promptTerms: ["audio", "headphones", "speakers", "wireless", "soundbar", "listening"], catalogTerms: ["wireless audio", "headphones", "speaker", "soundbar", "earbuds", "amplifier"], legacyVibe: "bold", generationInstructions: "Use a rim-lit technical launch, live specification comparison, and a protected three-piece ecosystem builder." }, 3),
  recipe({ id: "atelier", name: "Atelier", niche: "Elevated apparel and wardrobe basics", descriptor: "Fit laboratory / measured / calm", aliases: ["atelier fit laboratory"], strongPhrases: ["elevated basics", "apparel fit finder", "wardrobe essentials"], promptTerms: ["apparel", "garments", "wardrobe", "clothing", "fit", "basics"], catalogTerms: ["apparel", "garment", "wardrobe basics", "clothing", "size guide", "fabric"], legacyVibe: "minimal", generationInstructions: "Use a measured garment laboratory, shopper-entered fit preferences, live variants, and calm stone and oxblood styling." }, 3),
  recipe({ id: "gilt", name: "Gilt", niche: "Fine jewelry and personal accessories", descriptor: "Object ceremony / intimate / gifting-led", aliases: ["gilt object ceremony"], strongPhrases: ["fine jewelry", "engraved jewelry", "jewelry gifting"], promptTerms: ["jewelry", "gold", "engraving", "accessories", "keepsake", "recipient"], catalogTerms: ["fine jewelry", "gold jewelry", "engraving", "necklace", "bracelet", "earrings"], legacyVibe: "minimal", generationInstructions: "Use an intimate object ceremony with live jewelry, protected engraving, gift notes, wrapping, and recipient details." }, 3),
  recipe({ id: "ember", name: "Ember", niche: "Hot sauce and gourmet snacks", descriptor: "Tasting counter / heat-led / raw", aliases: ["ember tasting counter"], strongPhrases: ["hot sauce", "spicy snacks", "heat level tasting"], promptTerms: ["spicy", "sauce", "pepper", "heat", "snacks", "tasting"], catalogTerms: ["hot sauce", "spicy snack", "pepper sauce", "heat level", "tasting flight", "chili"], legacyVibe: "bold", generationInstructions: "Use a raw tasting counter, honest heat selection, tasting flights, and live catalog proof." }, 3),
  recipe({ id: "roast", name: "Roast", niche: "Specialty coffee and brewing", descriptor: "Origin notebook / brew-led / tactile", aliases: ["roast origin notebook"], strongPhrases: ["specialty coffee", "coffee roaster", "brew method"], promptTerms: ["coffee", "roaster", "beans", "brew", "espresso", "grind"], catalogTerms: ["specialty coffee", "coffee beans", "espresso", "grind size", "pour over", "single origin"], legacyVibe: "warm", generationInstructions: "Use an origin notebook, brew-method guidance, grind options, and protected subscription cadence." }, 3),
  recipe({ id: "fizz", name: "Fizz", niche: "Functional soda and non-alcoholic drinks", descriptor: "Flavor playground / buoyant / colorful", aliases: ["fizz flavor playground"], strongPhrases: ["functional soda", "non alcoholic drinks", "variety pack soda"], promptTerms: ["soda", "flavor", "sparkling", "adaptogen", "functional", "cans"], catalogTerms: ["functional soda", "sparkling drink", "non alcoholic", "variety pack", "adaptogen drink", "flavored soda"], legacyVibe: "bold", generationInstructions: "Use a buoyant flavor playground, personality guidance, and a live variety-pack path without unsupported wellness claims." }, 3),
  recipe({ id: "forge", name: "Forge", niche: "Professional hand tools and hardware", descriptor: "Jobsite blueprint / precise / rugged", aliases: ["forge jobsite blueprint"], strongPhrases: ["professional hand tools", "project tool kit", "tool compatibility"], promptTerms: ["tools", "hardware", "workshop", "jobsite", "project", "compatibility"], catalogTerms: ["hand tools", "hardware", "tool kit", "jobsite", "wrench", "screwdriver"], legacyVibe: "bold", generationInstructions: "Use a jobsite blueprint, merchant-supplied compatibility, project kits, and specification sheets." }, 4),
  recipe({ id: "haven", name: "Haven", niche: "Modern modular furniture", descriptor: "Spatial studies / material-led / quiet", aliases: ["haven spatial studio"], strongPhrases: ["modular furniture", "modern furniture", "room fit"], promptTerms: ["furniture", "modular", "sofa", "interior", "room", "swatch"], catalogTerms: ["modular furniture", "sofa", "sectional", "dining table", "material swatch", "room dimensions"], legacyVibe: "warm", generationInstructions: "Use quiet spatial studies, room-fit dimensions, material swatches, and live delivery information." }, 3),
  recipe({ id: "glow", name: "Glow", niche: "Clinical skincare and personal care", descriptor: "Clinical evidence / luminous / precise", aliases: ["glow clinical studio"], strongPhrases: ["clinical skincare", "skin routine", "ingredient glossary"], promptTerms: ["serum", "routine", "ingredients", "clinical", "replenishment"], catalogTerms: ["clinical skincare", "skin serum", "moisturizer", "ingredient glossary", "skin routine", "cleanser"], legacyVibe: "minimal", generationInstructions: "Use a luminous clinical evidence system, preference-led routine guidance, ingredient records, and replenishment." }, 3),
] as const;

function normalizedKey(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("und").replace(/[’‘`]/g, "'").replace(/[\p{Pd}-]+/gu, " ").replace(/\s+/g, " ").trim();
}

function isSafeArtifactReference(value: string): boolean {
  return /^(?:app|docs|public)\/[A-Za-z0-9._/#-]+$/.test(value) && !value.includes("..") && !value.includes("//");
}

function validateUniqueStrings(values: readonly string[], label: string, templateId: StoreTemplateId): void {
  if (!values.length) throw new Error(`Missing ${label}: ${templateId}`);
  const normalized = values.map(normalizedKey);
  if (normalized.some((value) => !value)) throw new Error(`Missing ${label}: ${templateId}`);
  if (new Set(normalized).size !== normalized.length) throw new Error(`Duplicate ${label}: ${templateId}`);
}

function isRouteSemanticValue(
  value: string,
  recipeIdentities: ReadonlySet<string>,
  routePattern: string,
  blueprintId: StorefrontRecipeBlueprintId,
): boolean {
  const suffix = `.${routePattern}.${blueprintId}`;
  return value.endsWith(suffix) && recipeIdentities.has(value.slice(0, -suffix.length));
}

function routeSemanticSignature(blueprint: StoreTemplateRouteBlueprint): string {
  return JSON.stringify([
    blueprint.compositionFamily,
    blueprint.heroTreatment,
    blueprint.scrollModel,
    blueprint.cardTopology,
    [...blueprint.iconRules].sort(),
    [...blueprint.signatureInteractions].sort(),
    [...blueprint.forbiddenGenericStructures].sort(),
  ]);
}

function validateBlueprint(
  blueprint: StoreTemplateRouteBlueprint,
  blueprintId: StorefrontRecipeBlueprintId,
  templateId: StoreTemplateId,
): void {
  if (!blueprint || !isSafeArtifactReference(blueprint.sourceRef)) {
    throw new Error(`Invalid route blueprint source reference: ${templateId}/${blueprintId}`);
  }
  if (!isRouteSemanticValue(blueprint.compositionFamily, COMPOSITION_FAMILIES, ROUTE_COMPOSITION_PATTERNS[blueprintId], blueprintId)) {
    throw new Error(`Invalid composition family: ${templateId}/${blueprintId}`);
  }
  if (!isRouteSemanticValue(blueprint.heroTreatment, HERO_TREATMENTS, ROUTE_HERO_PATTERNS[blueprintId], blueprintId)) {
    throw new Error(`Invalid hero treatment: ${templateId}/${blueprintId}`);
  }
  if (!isRouteSemanticValue(blueprint.scrollModel, SCROLL_MODELS, ROUTE_SCROLL_PATTERNS[blueprintId], blueprintId)) {
    throw new Error(`Invalid scroll model: ${templateId}/${blueprintId}`);
  }
  if (!isRouteSemanticValue(blueprint.cardTopology, CARD_TOPOLOGIES, ROUTE_CARD_PATTERNS[blueprintId], blueprintId)) {
    throw new Error(`Invalid card topology: ${templateId}/${blueprintId}`);
  }
  if (!isCuratedFontId(blueprint.displayFontId) || !isCuratedFontId(blueprint.bodyFontId)) {
    throw new Error(`Invalid curated font: ${templateId}/${blueprintId}`);
  }
  validateUniqueStrings(blueprint.iconRules, "icon rules", templateId);
  validateUniqueStrings(blueprint.signatureInteractions, "signature interactions", templateId);
  validateUniqueStrings(blueprint.forbiddenGenericStructures, "forbidden generic structures", templateId);
  if (!blueprint.protectedSlotPlacement.length) throw new Error(`Missing protected slot placement: ${templateId}/${blueprintId}`);
  const placementKeys = blueprint.protectedSlotPlacement.map((placement) => `${placement.slot}\u0000${placement.region}`);
  if (
    blueprint.protectedSlotPlacement.some(
      (placement) => !PROTECTED_SLOTS.has(placement.slot) || !/^[a-z][a-z0-9.-]*$/.test(placement.region),
    ) ||
    new Set(placementKeys).size !== placementKeys.length
  ) {
    throw new Error(`Invalid protected slot placement: ${templateId}/${blueprintId}`);
  }
}

function freezeTemplate(template: VersionedStoreTemplate): VersionedStoreTemplate {
  const versions = template.versions.map((version) => {
    const routeBlueprints = Object.fromEntries(
      ALL_BLUEPRINTS.map((blueprintId) => {
        const blueprint = version.routeBlueprints[blueprintId];
        return [
          blueprintId,
          Object.freeze({
            ...blueprint,
            iconRules: Object.freeze([...blueprint.iconRules]),
            protectedSlotPlacement: Object.freeze(
              blueprint.protectedSlotPlacement.map((placement) => Object.freeze({ ...placement })),
            ),
            signatureInteractions: Object.freeze([...blueprint.signatureInteractions]),
            forbiddenGenericStructures: Object.freeze([...blueprint.forbiddenGenericStructures]),
          }),
        ];
      }),
    ) as Record<StorefrontRecipeBlueprintId, StoreTemplateRouteBlueprint>;
    return Object.freeze({
      ...version,
      assets: Object.freeze({ entries: Object.freeze(version.assets.entries.map((entry) => Object.freeze({ ...entry }))) }),
      screenshots: Object.freeze({ ...version.screenshots }),
      visualLayer: Object.freeze({ ...version.visualLayer }),
      routeBlueprints: Object.freeze(routeBlueprints),
    });
  });
  return Object.freeze({
    ...template,
    aliases: Object.freeze([...template.aliases]),
    strongPhrases: Object.freeze([...template.strongPhrases]),
    promptTerms: Object.freeze([...template.promptTerms]),
    catalogTerms: Object.freeze([...template.catalogTerms]),
    versions: Object.freeze(versions),
    routeCapabilities: Object.freeze([...template.routeCapabilities]),
    overrideSurface: Object.freeze({
      designTokens: Object.freeze([...template.overrideSurface.designTokens]),
      textSlots: Object.freeze([...template.overrideSurface.textSlots]),
      optionalRegions: Object.freeze([...template.overrideSurface.optionalRegions]),
      reorderableRegions: Object.freeze([...template.overrideSurface.reorderableRegions]),
    }),
  });
}

export function createStoreTemplateRegistry(
  templates: readonly VersionedStoreTemplate[],
  versions: { registryVersion?: number; routingVersion?: number } = {},
): VersionedStoreTemplateRegistry {
  const ids = new Set<StoreTemplateId>();
  const namesAndAliases = new Set<string>();
  const semanticSignatures = new Set<string>();
  const visualSlots = new Set<string>();
  const validatedTemplates: VersionedStoreTemplate[] = [];
  for (const template of templates) {
    if (ids.has(template.id)) throw new Error(`Duplicate template ID: ${template.id}`);
    ids.add(template.id);
    if (template.activeVersion < 1 || !Number.isInteger(template.activeVersion)) throw new Error(`Invalid active version: ${template.id}`);
    const versionNumbers = new Set<number>();
    for (const version of template.versions) {
      const ownedAssetKeys = new Set(version.assets.entries.map(({ key }) => key));
      if (version.templateVersion < 1 || !Number.isInteger(version.templateVersion) || versionNumbers.has(version.templateVersion)) {
        throw new Error(`Invalid template version record: ${template.id}`);
      }
      versionNumbers.add(version.templateVersion);
      const artifactReferences = [version.baselineArtifact, version.screenshots.desktop, version.screenshots.mobile];
      if (artifactReferences.some((reference) => !isSafeArtifactReference(reference))) {
        throw new Error(`Invalid artifact reference: ${template.id}`);
      }
      if (
        !version.visualLayer?.slotId.startsWith("visual:") ||
        version.visualLayer.slotId.length === "visual:".length ||
        (version.visualLayer.placement !== "hero-background" && version.visualLayer.placement !== "section-background") ||
        version.visualLayer.pointerEvents !== "none"
      ) {
        throw new Error(`Invalid visual layer: ${template.id}@${version.templateVersion}`);
      }
      if (
        version.visualLayer.placement === "hero-background" &&
        version.visualLayer.fallbackAssetKey !== protectedHeroAssetKey(template.id)
      ) {
        throw new Error(`Hero visual fallback must use the protected owned visual fallback asset: ${template.id}`);
      }
      if (!ownedAssetKeys.has(version.visualLayer.fallbackAssetKey)) {
        throw new Error(`Unresolved owned visual fallback: ${template.id}`);
      }
      if (!ownedAssetKeys.has(version.productPlaceholderAssetKey)) {
        throw new Error(`Unresolved owned product placeholder: ${template.id}`);
      }
      const blueprintKeys = Object.keys(version.routeBlueprints);
      if (
        blueprintKeys.length !== ALL_BLUEPRINTS.length ||
        ALL_BLUEPRINTS.some((blueprint) => !version.routeBlueprints[blueprint])
      ) {
        throw new Error(`Incomplete route blueprint metadata: ${template.id}`);
      }
      const routeSemanticSignatures = new Set<string>();
      for (const blueprintId of ALL_BLUEPRINTS) {
        const blueprint = version.routeBlueprints[blueprintId];
        validateBlueprint(blueprint, blueprintId, template.id);
        const signature = routeSemanticSignature(blueprint);
        if (routeSemanticSignatures.has(signature)) throw new Error(`Duplicate route semantic signature: ${template.id}`);
        routeSemanticSignatures.add(signature);
      }
      for (const routeId of ["collection", "product"] as const) {
        if (!version.routeBlueprints[routeId].protectedSlotPlacement.some(({ slot }) => slot === "productDescription")) {
          throw new Error(`Missing product description placement: ${template.id}/${routeId}`);
        }
      }
    }
    if (!versionNumbers.has(template.activeVersion)) throw new Error(`Active version is not registered: ${template.id}`);
    const activeBlueprint = template.versions.find((version) => version.templateVersion === template.activeVersion)!.routeBlueprints.shell;
    const semanticSignature = JSON.stringify([
      activeBlueprint.compositionFamily,
      activeBlueprint.heroTreatment,
      activeBlueprint.scrollModel,
      activeBlueprint.cardTopology,
      activeBlueprint.displayFontId,
      activeBlueprint.bodyFontId,
      [...activeBlueprint.iconRules].sort(),
      [...activeBlueprint.signatureInteractions].sort(),
    ]);
    if (semanticSignatures.has(semanticSignature)) throw new Error(`Duplicate semantic signature: ${template.id}`);
    semanticSignatures.add(semanticSignature);
    for (const version of template.versions) {
      if (visualSlots.has(version.visualLayer.slotId)) {
        throw new Error(`Duplicate visual slot: ${version.visualLayer.slotId}`);
      }
      visualSlots.add(version.visualLayer.slotId);
    }
    if (ALL_ROUTES.some((route) => !template.routeCapabilities.includes(route)) || template.routeCapabilities.length !== ALL_ROUTES.length) {
      throw new Error(`Incomplete route capabilities: ${template.id}`);
    }
    for (const phrase of [template.name, ...template.aliases]) {
      const normalized = normalizedKey(phrase);
      if (!normalized || namesAndAliases.has(normalized)) throw new Error(`Duplicate template name or alias: ${phrase}`);
      namesAndAliases.add(normalized);
    }
    for (const [label, values] of [
      ["alias", template.aliases],
      ["strong phrase", template.strongPhrases],
      ["prompt term", template.promptTerms],
      ["catalog term", template.catalogTerms],
    ] as const) {
      const seen = new Set<string>();
      for (const value of values) {
        const normalized = normalizedKey(value);
        if (!normalized || seen.has(normalized)) throw new Error(`Duplicate ${label}: ${value}`);
        if ((label === "prompt term" || label === "catalog term") && GENERIC_COMMERCE_TERMS.has(normalized)) {
          throw new Error(`Generic commerce term is not allowed: ${value}`);
        }
        seen.add(normalized);
      }
    }
    validatedTemplates.push(freezeTemplate(template));
  }
  return Object.freeze({
    registryVersion: versions.registryVersion ?? 1,
    routingVersion: versions.routingVersion ?? 1,
    templates: Object.freeze(validatedTemplates),
  });
}

export const STORE_TEMPLATE_REGISTRY = createStoreTemplateRegistry(RECIPES, {
  registryVersion: 2,
  routingVersion: 1,
});

const TEMPLATE_BY_ID = new Map(STORE_TEMPLATE_REGISTRY.templates.map((template) => [template.id, template]));

export function isStoreTemplateId(value: unknown): value is RegisteredStoreTemplateId {
  return typeof value === "string" && TEMPLATE_BY_ID.has(value as StoreTemplateId);
}

export function getStoreTemplate(id: StoreTemplateId): VersionedStoreTemplate {
  const template = TEMPLATE_BY_ID.get(id);
  if (!template) throw new Error(`Unknown store template: ${id}`);
  return template;
}
