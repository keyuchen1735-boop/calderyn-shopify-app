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
import { getStoreTemplate } from "../storefront-bundle/registry";
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

export interface RecipeMediaArtifactEntry {
  contentHash: string;
  mediaType: string;
  byteSize: number;
  objectPath: string;
  localPath?: string;
}

export interface RecipeMediaArtifactRecord {
  templateId: string;
  role: string;
  masterHash: string;
  duration: number;
  width: number;
  height: number;
  entries: readonly RecipeMediaArtifactEntry[];
}

export interface RecipeMediaManifestArtifact {
  templateId: string;
  records: readonly RecipeMediaArtifactRecord[];
}

export interface RecipeMediaProofRecord {
  templateId: string;
  role: string;
  masterHash: string;
  duration?: number;
  width?: number;
  height?: number;
  technicalApproval?: { approved: boolean; masterHash: string; derivativeHashes?: readonly string[] };
  visualApproval?: { approved: boolean; scope: string };
}

export interface RecipeMediaProofArtifact {
  records: readonly RecipeMediaProofRecord[];
}

export interface RecipeMediaArtifacts {
  manifest: RecipeMediaManifestArtifact;
  proof: RecipeMediaProofArtifact;
}

export interface RecipeConfig<TTemplateId extends StoreTemplateId = StoreTemplateId> {
  templateId: TTemplateId;
  templateVersion: TTemplateId extends NewStoreTemplateId ? 1 | 2 | 3 : number;
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
  mediaArtifacts?: RecipeMediaArtifacts;
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

function assertApprovedVideoRole(config: RecipeConfig, role: string): void {
  const artifacts = config.mediaArtifacts;
  if (!artifacts) throw new Error(`Recipe ${config.templateId} video hero requires checked-in media manifest and approval proof`);
  if (artifacts.manifest.templateId !== config.templateId) {
    throw new Error(`Recipe ${config.templateId} video hero media manifest has a template identity mismatch`);
  }

  const heroRecords = artifacts.manifest.records.filter((record) => record.role === role);
  if (heroRecords.length !== 1) throw new Error(`Recipe ${config.templateId} video ${role} requires exactly one ${role} media role`);
  const hero = heroRecords[0]!;
  if (hero.templateId !== config.templateId || !/^[a-f0-9]{64}$/.test(hero.masterHash)) {
    throw new Error(`Recipe ${config.templateId} video hero media ownership or master identity is invalid`);
  }

  const approvals = artifacts.proof.records.filter((proof) =>
    proof.templateId === config.templateId && proof.role === role && proof.masterHash === hero.masterHash,
  );
  if (approvals.length !== 1) throw new Error(`Recipe ${config.templateId} video hero requires an exact approval proof identity`);
  const approval = approvals[0]!;
  if (approval.technicalApproval?.approved !== true || approval.technicalApproval.masterHash !== hero.masterHash ||
    approval.visualApproval?.approved !== true || approval.visualApproval.scope !== "full-loop") {
    throw new Error(`Recipe ${config.templateId} video hero requires distinct technical and full-loop visual approval proof`);
  }

  const expectedAssets = [
    [`${role}-poster`, "image/webp"],
    [`${role}-webm`, "video/webm"],
    [`${role}-mp4`, "video/mp4"],
  ] as const;
  if (hero.entries.length !== expectedAssets.length) {
    throw new Error(`Recipe ${config.templateId} video hero requires a complete derivative asset mapping`);
  }
  for (const [assetKey, mediaType] of expectedAssets) {
    const derivatives = hero.entries.filter((entry) => entry.mediaType === mediaType);
    const asset = config.assets.entries.find(({ key }) => key === assetKey);
    if (derivatives.length !== 1 || asset?.mediaType !== mediaType || asset.contentHash !== derivatives[0]!.contentHash) {
      throw new Error(`Recipe ${config.templateId} video hero derivative asset hash or media type mismatch for ${assetKey}`);
    }
  }
  const approvedHashes = [...(approval.technicalApproval?.derivativeHashes ?? [])].sort();
  if (JSON.stringify(approvedHashes) !== JSON.stringify(hero.entries.map(({ contentHash }) => contentHash).sort())) {
    throw new Error(`Recipe ${config.templateId} video ${role} derivative hashes are not exactly approved`);
  }
}

function assertApprovedReferencedVideos(config: RecipeConfig): void {
  const roles = new Set<string>();
  const approvedRoles = new Set(["hero", "hero-alt", "pdp-detail"]);
  for (const [surfaceId, surface] of Object.entries(config.surfaces)) {
    if (!surface) continue;
    const visit = (nodes: readonly CompiledNode[]): void => nodes.forEach((node) => {
      if (node.kind !== "element") return;
      if (node.tag === "video") {
        const poster = node.attributes["data-cd-poster-asset-key"];
        const sourceKeys = node.children.flatMap((child) => child.kind === "element" && child.tag === "source"
          ? [child.attributes["data-cd-asset-key"]]
          : []).filter((key): key is string => Boolean(key));
        const referencedRoles = [poster, ...sourceKeys].flatMap((key) => {
          const match = key?.match(/^(hero|hero-alt|pdp-detail)-(?:poster|webm|mp4)$/);
          return match ? [match[1]!] : [];
        });
        const role = referencedRoles[0];
        const expectedSourceKeys = role ? [`${role}-mp4`, `${role}-webm`] : [];
        if (node.attributes["data-cd-video"] !== "" || !role || !approvedRoles.has(role) ||
          referencedRoles.some((candidate) => candidate !== role) || poster !== `${role}-poster` ||
          JSON.stringify([...sourceKeys].sort()) !== JSON.stringify(expectedSourceKeys)) {
          throw new Error(`Recipe ${config.templateId} video on ${surfaceId} requires one trusted poster-first approved media role`);
        }
        roles.add(role);
      }
      visit(node.children);
    });
    const rootScopeKind = ("rootScopeKind" in surface.source ? surface.source.rootScopeKind : undefined) ??
      (["collection", "product", "search", "cart"].includes(surfaceId) ? surfaceId as "collection" | "product" | "search" | "cart" : "store");
    visit(compileHtml(surface.source.html, {
      namespace: surfaceId,
      rootScopeKind,
      checkoutDecorative: surfaceId === "checkout",
    }).tree);
  }
  for (const role of roles) assertApprovedVideoRole(config, role);
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
  if (!html.includes('data-cd-route="collection"')) {
    html += `<a class="recipe-platform-binding" data-cd-route="collection">Catalog</a>`;
  }
  if (!html.includes('data-cd-route="cart"')) {
    html += `<a class="recipe-platform-binding" data-cd-route="cart">Cart</a>`;
  }
  if (!html.includes("niche-icon")) {
    html += `<span class="niche-icon recipe-platform-binding" aria-hidden="true">${config.templateId}</span>`;
  }
  const responsiveCss = /@media\s*\(max-width:/.test(config.surfaces.shell.source.css)
    ? ""
    : "@media(max-width:720px){header nav{max-width:100%;overflow-x:auto}}";
  if (html === config.surfaces.shell.source.html && !responsiveCss) return config;
  return {
    ...config,
    surfaces: {
      ...config.surfaces,
      shell: {
        ...config.surfaces.shell,
        source: {
          ...config.surfaces.shell.source,
          html,
          css: `${config.surfaces.shell.source.css}${responsiveCss}footer,footer nav{display:flex;flex-wrap:wrap;gap:1rem}footer{padding:1rem}footer a,.recipe-platform-binding{color:inherit;text-decoration:none}.recipe-platform-binding{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}`,
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
      ...(config.surfaces.collections ? { collections: config.surfaces.collections.source } : {}),
      ...(config.surfaces.story ? { story: config.surfaces.story.source } : {}),
      ...(config.surfaces.notFound ? { notFound: config.surfaces.notFound.source } : {}),
    },
    assets: config.assets,
  };
}

export function recipeCompilerSource(recipe: DefinedRecipe): StorefrontBundleSourceV1 {
  return compilerSource(recipe.config);
}

function withRequiredCollectionCommerce<const TTemplateId extends StoreTemplateId>(
  config: RecipeConfig<TTemplateId>,
): RecipeConfig<TTemplateId> {
  const source = config.surfaces.collection.source;
  let html = source.html;
  if (!html.includes('data-cd-action="collection.filter"')) {
    html += `<button value="true" data-cd-on="click" data-cd-action="collection.filter" data-cd-facet="available">Available now</button>`;
  }
  if (!html.includes('data-cd-action="collection.sort"')) {
    html += `<button value="price_asc" data-cd-on="click" data-cd-action="collection.sort">Price, low first</button>`;
  }
  if (!html.includes('data-cd-slot="quickViewCommerce"')) {
    html += `<section data-cd-repeat="collection.products"><aside data-cd-key="product.id" data-cd-slot="quickViewCommerce" data-cd-product="product.id" data-cd-host-size="inline"></aside></section>`;
  }
  if (html === source.html) return config;
  return {
    ...config,
    surfaces: {
      ...config.surfaces,
      collection: {
        ...config.surfaces.collection,
        source: { ...source, html, css: `${source.css}button{min-height:44px}` },
      },
    },
  };
}

function withRequiredHomeCommerce<const TTemplateId extends StoreTemplateId>(
  config: RecipeConfig<TTemplateId>,
): RecipeConfig<TTemplateId> {
  const source = config.surfaces.home.source;
  let html = source.html;
  if ((["volt", "atelier", "gilt", "ember", "roast", "fizz", "forge", "haven", "glow"] as StoreTemplateId[]).includes(config.templateId)
    && !html.includes("cta-label")) {
    html = html.replace(/<a([^>]*data-cd-route="collection"[^>]*)>/, (tag, attributes: string) => {
      const className = `${config.templateId}-cta-label`;
      return attributes.includes('class="')
        ? tag.replace('class="', `class="${className} `)
        : `<a class="${className}"${attributes}>`;
    });
  }
  const hostTag = config.templateId === "ember" ? "section" : "aside";
  if (!html.includes('data-cd-slot="quickViewCommerce"')) {
    html += `<section data-cd-repeat="featured.products"><${hostTag} data-cd-key="product.id" data-cd-slot="quickViewCommerce" data-cd-product="product.id" data-cd-host-size="inline"></${hostTag}></section>`;
  }
  if (html === source.html) return config;
  return {
    ...config,
    surfaces: {
      ...config.surfaces,
      home: {
        ...config.surfaces.home,
        source: {
          ...source,
          html,
        },
      },
    },
  };
}

/** Compile a full recipe whose route markup and CSS remain owned by that recipe. */
export function defineRecipe<const TTemplateId extends StoreTemplateId>(
  config: RecipeConfig<TTemplateId>,
): DefinedRecipe<TTemplateId> {
  const boundConfig = withRequiredHomeCommerce(withRequiredCollectionCommerce(withRequiredShellBindings(config)));
  assertArchetypeMatchesRegistry(boundConfig);
  assertDistinctSurfaceSignatures(boundConfig);
  assertDeclaredHomeHero(boundConfig);
  assertApprovedReferencedVideos(boundConfig);
  return compileRecipeConfig(boundConfig);
}

/** Compile isolated recipe source without treating it as a registered production recipe. */
export function compileRecipeConfig<const TTemplateId extends StoreTemplateId>(
  config: RecipeConfig<TTemplateId>,
): DefinedRecipe<TTemplateId> {
  if (!Number.isInteger(config.templateVersion) || config.templateVersion < 1) {
    throw new Error(`Recipe ${config.templateId} must use a positive template version`);
  }
  const boundConfig = withRequiredHomeCommerce(withRequiredCollectionCommerce(withRequiredShellBindings(config)));
  assertDistinctSurfaceSignatures(boundConfig);
  const result = compileBundle(compilerSource(boundConfig));
  return { ...result, config: boundConfig };
}
