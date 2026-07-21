import postcss from "postcss";
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
    // Boundaries keep a family from matching inside a longer identifier — e.g.
    // "DM Mono" must not rewrite the middle of "DM-Mono-Bold" or "Manropes".
    new RegExp(`(?<![\\w-])(["']?)${family.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\1(?![\\w-])`, "gi"),
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
    // Inline :root custom properties, resolving nested references. Bounded so a
    // cyclic definition (--a:var(--b);--b:var(--a)) can't hang the build in an
    // ever-growing or oscillating rewrite; after the cap, unresolved refs stay.
    for (let pass = 0; pass < 32; pass += 1) {
      const next = declaration.value.replace(/var\((--[\w-]+)\)/g, (reference, variable: string) => (
        sourceVariables.get(variable) ?? reference
      ));
      if (next === declaration.value) break;
      declaration.value = next;
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
  const hero = config.assets.entries.find(({ key }) => key === "hero");
  if (hero?.mediaType !== "image/webp" || !config.surfaces.home.source.html.includes('data-cd-asset="hero"')) {
    throw new Error(`Recipe ${config.templateId} must include a declared home hero image`);
  }
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

function compilerSource(config: RecipeConfig): StorefrontBundleSourceV1 {
  return {
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
  };
}

export function recipeCompilerSource(recipe: DefinedRecipe): StorefrontBundleSourceV1 {
  return compilerSource(recipe.config);
}

/** Compile a full recipe whose route markup and CSS remain owned by that recipe. */
export function defineRecipe<const TTemplateId extends StoreTemplateId>(
  config: RecipeConfig<TTemplateId>,
): DefinedRecipe<TTemplateId> {
  const boundConfig = withRequiredShellBindings(config);
  assertArchetypeMatchesRegistry(boundConfig);
  assertDistinctSurfaceSignatures(boundConfig);
  assertDeclaredHomeHero(boundConfig);
  const result = compileBundle(compilerSource(boundConfig));
  return { ...result, config: boundConfig };
}
