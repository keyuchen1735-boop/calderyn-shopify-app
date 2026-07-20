import postcss from "postcss";
import {
  type AssetManifest,
  type RecipeCardIdentity,
  type RecipeCompositionIdentity,
  type RecipeHeroIdentity,
  type NewStoreTemplateId,
  type RecipeScrollIdentity,
  type CompiledNode,
  type StoreTemplateId,
} from "../storefront-bundle/types";
import { getStoreTemplate, isStoreTemplateId } from "../storefront-bundle/registry";
import {
  compileBundle,
  type CheckoutRouteSource,
  type CompiledBundleResult,
  type RouteSource,
  type StorefrontBundleSourceV1,
} from "../storefront-compiler/compile";
import { compileHtml } from "../storefront-compiler/html";

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
  templateVersion: TTemplateId extends NewStoreTemplateId ? 1 : number;
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
    collections?: RecipeSurface<RouteSource>;
    story?: RecipeSurface<RouteSource>;
    notFound?: RecipeSurface<RouteSource>;
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

/** Keeps source-template CSS for the classes and semantic tags retained by a safe recipe surface. */
export function sourceTemplateCss(
  sourceHtml: string,
  surfaceHtml: string,
  fonts: { display: string; body: string },
): string {
  const css = sourceHtml.match(/<style[^>]*>([\s\S]*?)<\/style>/i)?.[1] ?? "";
  const classes = new Set([...surfaceHtml.matchAll(/class=["']([^"']+)["']/g)]
    .flatMap(([, value]) => value!.split(/\s+/).filter(Boolean)));
  const tags = new Set([...surfaceHtml.matchAll(/<([a-z][a-z0-9-]*)\b/gi)].map(([, tag]) => tag!.toLowerCase()));
  const rootClass = surfaceHtml.match(/^\s*<[a-z][^>]*\bclass=["']([^"'\s]+)/i)?.[1];
  const rootTag = surfaceHtml.match(/^\s*<([a-z][a-z0-9-]*)\b/i)?.[1]?.toLowerCase();
  const rootSelector = rootClass ? `.${rootClass}` : rootTag;
  const root = postcss.parse(css);
  const sourceVariables = new Map<string, string>();
  root.walkRules((rule) => {
    if (!rule.selectors.some((selector) => selector.trim() === ":root")) return;
    rule.walkDecls(/^--/, (declaration) => {
      sourceVariables.set(declaration.prop, declaration.value);
    });
  });
  root.walkRules((rule) => {
    if (rule.parent?.type === "atrule" && rule.parent.name.toLowerCase() === "keyframes") return;
    const selectors = rule.selectors.flatMap((selector) => {
      const trimmed = selector.trim();
      if (trimmed === "*" && rootSelector) return [rootSelector, ...[...classes].map((name) => `.${name}`)];
      const universalPseudo = trimmed.match(/^\*((?:::?)(?:before|after))$/i)?.[1];
      if (universalPseudo && rootSelector) {
        return [`${rootSelector}${universalPseudo}`, ...[...classes].map((name) => `.${name}${universalPseudo}`)];
      }
      if (/^body\b/i.test(trimmed) && rootSelector) selector = trimmed.replace(/^body\b/i, rootSelector);
      if (/^\s*(?::root|html\b|body\b)/i.test(selector)) return [];
      if (/\.(?:active|open)(?![\w-])/.test(selector)) return [];
      if ([...classes].some((name) => new RegExp(`\\.${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(selector))) return [selector];
      const tag = selector.trim().match(/^([a-z][a-z0-9-]*)$/i)?.[1]?.toLowerCase();
      return tag !== undefined && tags.has(tag) ? [selector] : [];
    });
    if (selectors.length === 0) rule.remove();
    else rule.selectors = selectors;
  });
  root.walkAtRules((rule) => {
    if (rule.name.toLowerCase() !== "media" && rule.name.toLowerCase() !== "keyframes") rule.remove();
    else if (rule.nodes?.length === 0) rule.remove();
  });
  const replaceFont = (value: string, family: string, variable: string) => value.replace(
    new RegExp(`(["']?)${family.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\1`, "gi"),
    variable,
  );
  root.walkDecls((declaration) => {
    if (declaration.prop === "font" || declaration.prop === "font-family") {
      declaration.value = replaceFont(
        replaceFont(declaration.value, fonts.display, "var(--font-display)"),
        fonts.body,
        "var(--font-body)",
      );
    }
    for (let prior = ""; prior !== declaration.value;) {
      prior = declaration.value;
      declaration.value = declaration.value.replace(/var\((--[\w-]+)\)/g, (reference, variable: string) => (
        sourceVariables.get(variable) ?? reference
      ));
    }
    if (declaration.prop === "position" && declaration.value.trim() === "fixed") {
      declaration.value = "sticky";
    }
  });
  return `${root.toString()}.resilient-copy,#heroTitle{overflow-wrap:anywhere}`;
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

function assertDeclaredHomeHero(config: RecipeConfig): void {
  const homeHtml = config.surfaces.home.source.html;
  const hero = config.assets.entries.find(({ key }) => key === "hero");
  const legacyHero = hero?.mediaType === "image/webp" && homeHtml.includes('data-cd-asset="hero"');
  if (legacyHero) return;

  const mediaTypes = new Map(config.assets.entries.map(({ key, mediaType }) => [key, mediaType]));
  const completeManifest = mediaTypes.get("hero-poster") === "image/webp" &&
    mediaTypes.get("hero-webm") === "video/webm" && mediaTypes.get("hero-mp4") === "video/mp4";
  let completeMarkup = false;
  if (completeManifest) {
    const containsHeroVideo = (nodes: readonly CompiledNode[]): boolean => nodes.some((node) => {
      if (node.kind !== "element") return false;
      if (node.tag === "video" && node.attributes["data-cd-video"] === "" &&
        node.attributes["data-cd-poster-asset-key"] === "hero-poster") {
        const sources = node.children.filter((child) => child.kind === "element" && child.tag === "source");
        return sources.some((source) => source.kind === "element" && source.attributes["data-cd-asset-key"] === "hero-webm" && source.attributes.type === "video/webm") &&
          sources.some((source) => source.kind === "element" && source.attributes["data-cd-asset-key"] === "hero-mp4" && source.attributes.type === "video/mp4");
      }
      return containsHeroVideo(node.children);
    });
    completeMarkup = containsHeroVideo(compileHtml(homeHtml, { namespace: "home" }).tree);
  }
  if (!completeMarkup) throw new Error(`Recipe ${config.templateId} must include a declared home hero image or complete poster-first home hero video`);
}

function withRequiredShellBindings<const TTemplateId extends StoreTemplateId>(
  config: RecipeConfig<TTemplateId>,
): RecipeConfig<TTemplateId> {
  let html = config.surfaces.shell.source.html;
  if (!html.includes('data-cd-text="store.name"')) {
    html += `<span class="recipe-platform-binding" data-cd-text="store.name"></span>`;
  }
  if (!html.includes('data-cd-route="account"')) {
    html += `<a class="recipe-platform-binding" data-cd-route="account">Account</a>`;
  }
  if (!html.includes('data-cd-route="home"')) {
    html += `<a class="recipe-platform-binding" data-cd-route="home">Home</a>`;
  }
  if (!html.includes("niche-icon")) {
    html += `<span class="niche-icon recipe-platform-binding" aria-hidden="true">${config.templateId}</span>`;
  }
  if (html === config.surfaces.shell.source.html) return config;
  return {
    ...config,
    surfaces: {
      ...config.surfaces,
      shell: {
        ...config.surfaces.shell,
        source: {
          ...config.surfaces.shell.source,
          html,
          css: `${config.surfaces.shell.source.css}footer,footer nav{display:flex;flex-wrap:wrap;gap:1rem}footer{padding:1rem}footer a,.recipe-platform-binding{color:inherit;text-decoration:none}.recipe-platform-binding{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}`,
        },
      },
    },
  };
}

/** Compile a full recipe whose route markup and CSS remain owned by that recipe. */
export function defineRecipe<const TTemplateId extends StoreTemplateId>(
  config: RecipeConfig<TTemplateId>,
): DefinedRecipe<TTemplateId> {
  const boundConfig = withRequiredShellBindings(config);
  assertArchetypeMatchesRegistry(boundConfig);
  assertDistinctSurfaceSignatures(boundConfig);
  assertDeclaredHomeHero(boundConfig);
  return compileRecipeConfig(boundConfig);
}

/** Compile isolated recipe source without treating it as a registered production recipe. */
export function compileRecipeConfig<const TTemplateId extends StoreTemplateId>(
  config: RecipeConfig<TTemplateId>,
): DefinedRecipe<TTemplateId> {
  if (!isStoreTemplateId(config.templateId) && config.templateVersion !== 1) {
    throw new Error(`Unregistered recipe ${config.templateId} must use template version 1`);
  }
  const boundConfig = withRequiredShellBindings(config);
  assertDistinctSurfaceSignatures(boundConfig);
  const result = compileBundle({
    source: {
      kind: "recipe",
      templateId: boundConfig.templateId,
      templateVersion: boundConfig.templateVersion,
    },
    concept: boundConfig.concept,
    designSystem: boundConfig.designSystem,
    shell: boundConfig.surfaces.shell.source,
    routes: {
      home: boundConfig.surfaces.home.source,
      collection: boundConfig.surfaces.collection.source,
      product: boundConfig.surfaces.product.source,
      search: boundConfig.surfaces.search.source,
      cart: boundConfig.surfaces.cart.source,
      checkout: boundConfig.surfaces.checkout.source,
      ...(boundConfig.surfaces.collections ? { collections: boundConfig.surfaces.collections.source } : {}),
      ...(boundConfig.surfaces.story ? { story: boundConfig.surfaces.story.source } : {}),
      ...(boundConfig.surfaces.notFound ? { notFound: boundConfig.surfaces.notFound.source } : {}),
    },
    assets: boundConfig.assets,
  });
  return { ...result, config: boundConfig };
}
