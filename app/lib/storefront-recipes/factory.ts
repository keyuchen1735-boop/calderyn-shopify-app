import {
  type AssetManifest,
  type RecipeCardIdentity,
  type RecipeCompositionIdentity,
  type RecipeHeroIdentity,
  type RecipeScrollIdentity,
  type StoreTemplateId,
} from "../storefront-bundle/types";
import { getStoreTemplate } from "../storefront-bundle/registry";
import {
  compileBundle,
  type CheckoutRouteSource,
  type CompiledBundleResult,
  type RouteSource,
  type StorefrontBundleSourceV1,
} from "../storefront-compiler/compile";

export interface RecipeArchetype {
  composition: RecipeCompositionIdentity;
  hero: RecipeHeroIdentity;
  scroll: RecipeScrollIdentity;
  cards: RecipeCardIdentity;
  iconography: string[];
}

export interface RecipeSurface<TSource> {
  /** A short structural description used by contract tests to prevent route-template collapse. */
  signature: string;
  source: TSource;
}

export interface RecipeConfig<TTemplateId extends StoreTemplateId = StoreTemplateId> {
  templateId: TTemplateId;
  templateVersion: number;
  concept: StorefrontBundleSourceV1["concept"];
  designSystem: StorefrontBundleSourceV1["designSystem"];
  archetype: RecipeArchetype;
  surfaces: {
    shell: RecipeSurface<RouteSource>;
    home: RecipeSurface<RouteSource>;
    collection: RecipeSurface<RouteSource>;
    product: RecipeSurface<RouteSource>;
    search: RecipeSurface<RouteSource>;
    cart: RecipeSurface<RouteSource>;
    checkout: RecipeSurface<CheckoutRouteSource>;
  };
  assets: AssetManifest;
}

export interface DefinedRecipe<TTemplateId extends StoreTemplateId = StoreTemplateId> extends CompiledBundleResult {
  config: RecipeConfig<TTemplateId>;
}

/** Adds a recipe-owned semantic landmark immediately inside a route root. */
export function prependRecipeLandmark<TSource extends { html: string }>(
  source: TSource,
  landmarkHtml: string,
): TSource {
  const rootEnd = source.html.indexOf(">");
  if (rootEnd < 0) throw new Error("Recipe route markup requires a root element");
  return {
    ...source,
    html: `${source.html.slice(0, rootEnd + 1)}${landmarkHtml}${source.html.slice(rootEnd + 1)}`,
  };
}

/** Wraps checkout decoration in a recipe-owned semantic composition region. */
export function wrapRecipeComposition<TSource extends { html: string }>(
  source: TSource,
  wrapper: "section" | "article" | "aside" | "nav",
  className: string,
): TSource {
  return { ...source, html: `<${wrapper} class="${className}">${source.html}</${wrapper}>` };
}

const SURFACE_IDS = ["shell", "home", "collection", "product", "search", "cart", "checkout"] as const;

function assertArchetypeMatchesRegistry(config: RecipeConfig): void {
  const template = getStoreTemplate(config.templateId);
  const version = template.versions.find((candidate) => candidate.templateVersion === config.templateVersion);
  if (!version) throw new Error(`Unknown recipe version ${config.templateId}@${config.templateVersion}`);
  const home = version.routeBlueprints.home;
  const expected = {
    composition: home.compositionFamily.split(".", 1)[0],
    hero: home.heroTreatment.split(".", 1)[0],
    scroll: home.scrollModel.split(".", 1)[0],
    cards: home.cardTopology.split(".", 1)[0],
  };
  for (const field of ["composition", "hero", "scroll", "cards"] as const) {
    if (config.archetype[field] !== expected[field]) {
      throw new Error(`Recipe ${config.templateId} must use registered ${field} archetype ${expected[field]}`);
    }
  }
  if (
    config.designSystem.displayFontId !== home.displayFontId ||
    config.designSystem.bodyFontId !== home.bodyFontId
  ) {
    throw new Error(`Recipe ${config.templateId} must use its registered curated font pairing`);
  }
}

function assertDistinctSurfaceSignatures(config: RecipeConfig): void {
  const signatures = SURFACE_IDS.map((surfaceId) => config.surfaces[surfaceId].signature.trim());
  if (signatures.some((signature) => signature.length < 8 || signature.length > 160)) {
    throw new Error("Recipe route composition signatures must contain 8-160 characters");
  }
  if (new Set(signatures).size !== signatures.length) {
    throw new Error("Recipe routes must declare distinct route composition signatures");
  }
}

/** Compile a full recipe whose route markup and CSS remain owned by that recipe. */
export function defineRecipe<const TTemplateId extends StoreTemplateId>(
  config: RecipeConfig<TTemplateId>,
): DefinedRecipe<TTemplateId> {
  assertArchetypeMatchesRegistry(config);
  assertDistinctSurfaceSignatures(config);
  const result = compileBundle({
    source: {
      kind: "recipe",
      templateId: config.templateId,
      templateVersion: config.templateVersion,
    },
    concept: config.concept,
    designSystem: config.designSystem,
    shell: config.surfaces.shell.source,
    routes: {
      home: config.surfaces.home.source,
      collection: config.surfaces.collection.source,
      product: config.surfaces.product.source,
      search: config.surfaces.search.source,
      cart: config.surfaces.cart.source,
      checkout: config.surfaces.checkout.source,
    },
    assets: config.assets,
  });
  return { ...result, config };
}
