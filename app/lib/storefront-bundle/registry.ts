import type {
  StoreTemplateId,
  StorefrontRouteId,
  VersionedStoreTemplate,
  VersionedStoreTemplateRegistry,
} from "./types";

const ALL_ROUTES: readonly StorefrontRouteId[] = ["home", "collection", "product", "search", "cart", "checkout"];
const GENERIC_COMMERCE_TERMS = new Set(["shop", "product", "collection", "sale", "new", "premium", "gift"]);

const DEFAULT_OVERRIDE_SURFACE = {
  designTokens: ["color", "typography", "spacing", "radius", "motion"],
  textSlots: ["announcement", "heroEyebrow", "heroTitle", "heroBody", "sectionHeading", "ctaLabel"],
  optionalRegions: ["announcement", "editorialStory", "socialProof", "newsletter"],
  reorderableRegions: ["featuredCollection", "editorialStory", "socialProof", "newsletter"],
} as const;

function recipe(
  value: Omit<VersionedStoreTemplate, "activeVersion" | "routeCapabilities" | "overrideSurface" | "previewSrc">,
): VersionedStoreTemplate {
  return {
    ...value,
    activeVersion: 1,
    routeCapabilities: ALL_ROUTES,
    overrideSurface: DEFAULT_OVERRIDE_SURFACE,
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
  }),
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
  }),
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
  }),
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
  }),
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
  }),
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
  }),
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
  }),
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
  }),
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
  }),
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
  }),
  recipe({
    id: "atelier-nine",
    name: "Atelier Grid",
    niche: "Editorial fashion, beauty, jewelry, and quiet luxury",
    descriptor: "Editorial / restrained / fashion-led",
    aliases: ["atelier nine", "atelier"],
    strongPhrases: ["quiet luxury", "editorial fashion", "jewelry label", "fashion studio", "luxury skincare"],
    promptTerms: ["editorial", "fashion", "jewelry", "luxury", "apparel", "studio"],
    catalogTerms: ["fashion", "jewelry", "apparel", "quiet luxury", "fine jewelry", "designer clothing"],
    legacyVibe: "minimal",
    generationInstructions: "Use a warm-white asymmetric magazine grid, condensed display type, thin rules, vermilion accents, and restrained motion.",
  }),
] as const;

function normalizedKey(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("und").replace(/[’‘`]/g, "'").replace(/[\p{Pd}-]+/gu, " ").replace(/\s+/g, " ").trim();
}

export function createStoreTemplateRegistry(
  templates: readonly VersionedStoreTemplate[],
  versions: { registryVersion?: number; routingVersion?: number } = {},
): VersionedStoreTemplateRegistry {
  const ids = new Set<StoreTemplateId>();
  const namesAndAliases = new Set<string>();
  for (const template of templates) {
    if (ids.has(template.id)) throw new Error(`Duplicate template ID: ${template.id}`);
    ids.add(template.id);
    if (template.activeVersion < 1 || !Number.isInteger(template.activeVersion)) throw new Error(`Invalid active version: ${template.id}`);
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
  }
  return Object.freeze({
    registryVersion: versions.registryVersion ?? 1,
    routingVersion: versions.routingVersion ?? 1,
    templates: Object.freeze([...templates]),
  });
}

export const STORE_TEMPLATE_REGISTRY = createStoreTemplateRegistry(RECIPES);

const TEMPLATE_BY_ID = new Map(STORE_TEMPLATE_REGISTRY.templates.map((template) => [template.id, template]));

export function isStoreTemplateId(value: unknown): value is StoreTemplateId {
  return typeof value === "string" && TEMPLATE_BY_ID.has(value as StoreTemplateId);
}

export function getStoreTemplate(id: StoreTemplateId): VersionedStoreTemplate {
  const template = TEMPLATE_BY_ID.get(id);
  if (!template) throw new Error(`Unknown store template: ${id}`);
  return template;
}
