import { createHash } from "node:crypto";
import {
  STOREFRONT_RUNTIME_VERSION,
  STOREFRONT_SCHEMA_VERSION,
  STOREFRONT_VALIDATION_PROFILE_VERSION,
  isCuratedFontId,
  type AssetManifest,
  type CheckoutLayoutManifest,
  type CompiledNode,
  type CuratedFontId,
  type DataRequirement,
  type RuntimeCapability,
  type StorefrontBundleV1,
  type StoreTemplateId,
} from "../storefront-bundle/types";
import { CompilerError, type BindingScopeKind } from "./bindings";
import { assertValidAssetEntry, isCompilerIdentifier } from "./assets";
import { compileCheckout } from "./checkout";
import { RUNTIME_CSS_CUSTOM_PROPERTY_IDS, assertSafeDesignTokenValue, compileCss, requiredCssCustomPropertyIds } from "./css";
import { compileHtml, type ProtectedCssNode } from "./html";
import { validateCompiledBundle, type BundleValidationReport } from "./validate";

export interface RouteSource {
  html: string;
  css: string;
  requiredData: DataRequirement[];
  requiredCapabilities: RuntimeCapability[];
  rootScopeKind?: BindingScopeKind;
}

export interface CheckoutRouteSource {
  html: string;
  css: string;
  layout: CheckoutLayoutManifest;
}

export interface StorefrontBundleSourceV1 {
  source: StorefrontBundleV1["source"];
  concept: StorefrontBundleV1["concept"];
  designSystem: {
    displayFontId: CuratedFontId;
    bodyFontId: CuratedFontId;
    tokens: Record<string, string>;
    breakpoints: Record<string, number>;
    iconStyle: string;
    motionStyle: string;
    globalCss: string;
  };
  shell: RouteSource;
  routes: {
    home: RouteSource;
    collection: RouteSource;
    product: RouteSource;
    search: RouteSource;
    cart: RouteSource;
    checkout: CheckoutRouteSource;
    collections?: RouteSource;
    story?: RouteSource;
    notFound?: RouteSource;
  };
  assets: AssetManifest;
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const DATA_ORDER: readonly DataRequirement["kind"][] = [
  "storeIdentity", "policyLinks", "currentProduct", "currentCollection", "cart", "featuredProducts", "featuredCollections",
  "relatedProducts", "searchResults",
];
const CAPABILITY_ORDER: readonly RuntimeCapability[] = [
  "navigation", "localState", "overlay", "catalogFiltering", "catalogSearch", "commerce",
];

function deriveRouteContract(
  namespace: string,
  rootScope: BindingScopeKind,
  html: ReturnType<typeof compileHtml>,
): { requiredData: DataRequirement[]; requiredCapabilities: RuntimeCapability[] } {
  const data = new Map<DataRequirement["kind"], DataRequirement>();
  const requireData = (requirement: DataRequirement): void => {
    if (!data.has(requirement.kind)) data.set(requirement.kind, requirement);
  };
  for (const binding of html.bindings) {
    if (binding.ref.kind !== "data") continue;
    const owner = binding.ref.path.slice(0, binding.ref.path.indexOf("."));
    if (owner === "store") requireData({ kind: "storeIdentity" });
    else if (owner === "collection") requireData({ kind: "currentCollection" });
    else if (owner === "cart" || owner === "cartLine") requireData({ kind: "cart" });
    else if (owner === "search") requireData({ kind: "searchResults", limit: 24 });
    else if (binding.ref.scopeId === "root" && (owner === "product" || owner === "variant")) {
      requireData({ kind: "currentProduct" });
    }
  }
  for (const repeat of html.repeats) {
    if (repeat.source === "collection.products") requireData({ kind: "currentCollection" });
    else if (repeat.source === "featured.products") requireData({ kind: "featuredProducts", limit: 12 });
    else if (repeat.source === "featured.collections") requireData({ kind: "featuredCollections", limit: 12 });
    else if (repeat.source === "related.products") requireData({ kind: "relatedProducts", limit: 8 });
    else if (repeat.source === "search.results") requireData({ kind: "searchResults", limit: 24 });
    else if (repeat.source === "cart.lines") requireData({ kind: "cart" });
    else requireData({ kind: "currentProduct" });
  }
  if (html.policyLinks) requireData({ kind: "policyLinks" });
  if (rootScope === "collection") requireData({ kind: "currentCollection" });
  if (rootScope === "product") requireData({ kind: "currentProduct" });
  if (rootScope === "search") requireData({ kind: "searchResults", limit: 24 });
  if (rootScope === "cart") requireData({ kind: "cart" });
  for (const slot of html.trustedSlots) {
    if (slot.kind === "bundleBuilder") requireData({ kind: "featuredProducts", limit: 12 });
    else if (slot.kind === "cartLineControls" || slot.kind === "cartSummary" || slot.kind === "cartDrawer") requireData({ kind: "cart" });
    else if (namespace === "product" && !slot.scopeId) requireData({ kind: "currentProduct" });
  }

  const capabilities = new Set<RuntimeCapability>();
  if (html.routeTargets.length > 0) capabilities.add("navigation");
  if (html.interactions.state.length > 0 || html.interactions.bindings.length > 0 || html.interactions.transitions.length > 0) {
    capabilities.add("localState");
  }
  if (html.interactions.transitions.some((transition) => transition.action.type.startsWith("surface."))) capabilities.add("overlay");
  if (namespace === "collection" || html.interactions.transitions.some((transition) => transition.action.type.startsWith("collection."))) {
    capabilities.add("catalogFiltering");
  }
  if (namespace === "search" || html.interactions.transitions.some((transition) => transition.action.type.startsWith("search."))) {
    capabilities.add("catalogSearch");
  }
  if (html.trustedSlots.length > 0) capabilities.add("commerce");
  if (html.trustedSlots.some((slot) => slot.kind === "cartDrawer" || slot.kind === "quickViewCommerce")) capabilities.add("overlay");

  return {
    requiredData: DATA_ORDER.flatMap((kind) => {
      const requirement = data.get(kind);
      return requirement ? [requirement] : [];
    }),
    requiredCapabilities: CAPABILITY_ORDER.filter((capability) => capabilities.has(capability)),
  };
}

function compileRoute(source: RouteSource, namespace: string, defaultScope: BindingScopeKind) {
  const rootScope = source.rootScopeKind ?? defaultScope;
  const html = compileHtml(source.html, {
    namespace,
    rootScopeKind: rootScope,
  });
  const css = compileCss(source.css, {
    namespace,
    protectedNodes: html.protectedCssNodes,
    protectedSourceIds: html.protectedSourceIds,
  });
  const contract = deriveRouteContract(namespace, rootScope, html);
  return {
    artifact: {
      html: html.html,
      tree: html.tree,
      bindings: html.bindings,
      css: css.css,
      requiredData: contract.requiredData,
      requiredCapabilities: contract.requiredCapabilities,
      interactions: html.interactions,
      trustedSlots: html.trustedSlots,
    },
    protectedNodes: html.protectedCssNodes,
    protectedSourceIds: html.protectedSourceIds,
  };
}

function compileAssets(assets: AssetManifest): AssetManifest {
  const keys = new Set<string>();
  const entries = assets.entries.map((entry) => {
    assertValidAssetEntry(entry);
    if (keys.has(entry.key)) throw new CompilerError("asset.duplicate", `Duplicate asset key ${entry.key}`);
    keys.add(entry.key);
    return { key: entry.key, contentHash: entry.contentHash, mediaType: entry.mediaType, byteSize: entry.byteSize };
  });
  entries.sort((a, b) => compareCodeUnits(a.key, b.key));
  return { entries };
}

function compileDesignSystem(
  source: StorefrontBundleSourceV1["designSystem"],
  protectedNodes: readonly ProtectedCssNode[],
  protectedSourceIds: readonly string[],
): StorefrontBundleV1["designSystem"] {
  if (!isCuratedFontId(source.displayFontId) || !isCuratedFontId(source.bodyFontId)) {
    throw new CompilerError("design.font", "Design system fonts must come from the curated self-hosted set");
  }
  const tokens: Record<string, string> = {};
  for (const [key, value] of Object.entries(source.tokens).sort(([a], [b]) => compareCodeUnits(a, b))) {
    if (!isCompilerIdentifier(key)) throw new CompilerError("design.token", `Invalid token ID ${JSON.stringify(key)}`);
    assertSafeDesignTokenValue(key, value);
    tokens[key] = value;
  }
  const breakpoints: Record<string, number> = {};
  for (const [key, value] of Object.entries(source.breakpoints).sort(([a], [b]) => compareCodeUnits(a, b))) {
    if (!isCompilerIdentifier(key) || !Number.isFinite(value) || value < 240 || value > 3840) {
      throw new CompilerError("design.breakpoint", `Invalid breakpoint ${JSON.stringify(key)}`);
    }
    breakpoints[key] = value;
  }
  if (source.iconStyle.length > 120 || source.motionStyle.length > 120) {
    throw new CompilerError("design.description", "Design system descriptions exceed their bounded length");
  }
  return {
    displayFontId: source.displayFontId,
    bodyFontId: source.bodyFontId,
    tokens,
    breakpoints,
    iconStyle: source.iconStyle,
    motionStyle: source.motionStyle,
    globalCss: compileCss(source.globalCss, { namespace: "global", protectedNodes, protectedSourceIds }).css,
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => compareCodeUnits(a, b))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

export function canonicalizeCompiledBundle(bundle: StorefrontBundleV1): string {
  return JSON.stringify(stableValue(bundle));
}

export function hashCompiledBundle(bundle: StorefrontBundleV1): string {
  return createHash("sha256").update(canonicalizeCompiledBundle(bundle)).digest("hex");
}

export interface CompiledBundleResult {
  bundle: StorefrontBundleV1;
  hash: string;
  report: BundleValidationReport;
}

function assertDesignTokenCoverage(bundle: StorefrontBundleV1): void {
  const tokenIds = new Set([...Object.keys(bundle.designSystem.tokens), ...RUNTIME_CSS_CUSTOM_PROPERTY_IDS]);
  const cssArtifacts = [
    ["designSystem.globalCss", bundle.designSystem.globalCss],
    ["shell.css", bundle.shell.css],
    ...Object.entries(bundle.routes).map(([routeId, route]) => [
      `routes.${routeId}.css`,
      routeId === "checkout" ? bundle.routes.checkout.decorativeCss : (route as StorefrontBundleV1["routes"]["home"]).css,
    ] as const),
  ] as const;
  for (const [path, css] of cssArtifacts) {
    for (const tokenId of requiredCssCustomPropertyIds(css)) {
      if (!tokenIds.has(tokenId)) throw new CompilerError("design.token_reference", `${path} references missing design token --${tokenId}`);
    }
  }
  const themeTokenIds = [bundle.shell, bundle.routes.home, bundle.routes.collection, bundle.routes.product, bundle.routes.search, bundle.routes.cart, bundle.routes.collections, bundle.routes.story, bundle.routes.notFound]
    .filter((route): route is NonNullable<typeof route> => Boolean(route))
    .flatMap((route) => route.trustedSlots)
    .flatMap((slot) => slot.themeTokenIds);
  const layoutTokenIds = [bundle.routes.checkout.layout.spacingTokenId, ...bundle.routes.checkout.layout.surfaceTokenIds];
  for (const tokenId of [...themeTokenIds, ...layoutTokenIds]) {
    if (!tokenIds.has(tokenId)) throw new CompilerError("design.token_reference", `Storefront manifest references missing design token --${tokenId}`);
  }
}

function assertShellPolicyPlacement(nodes: readonly CompiledNode[], insideFooter = false): void {
  for (const node of nodes) {
    if (node.kind === "text") continue;
    const isInsideFooter = insideFooter || node.tag === "footer";
    if (node.attributes["data-cd-platform-content"] === "policyLinks" && !isInsideFooter) {
      throw new CompilerError("shell.policy_placement", "Shell policy links must be contained by a footer so they render after route content");
    }
    assertShellPolicyPlacement(node.children, isInsideFooter);
  }
}

export function compileBundle(source: StorefrontBundleSourceV1): CompiledBundleResult {
  const shell = compileRoute(source.shell, "shell", "store");
  assertShellPolicyPlacement(shell.artifact.tree);
  const home = compileRoute(source.routes.home, "home", "store");
  const collection = compileRoute(source.routes.collection, "collection", "collection");
  const product = compileRoute(source.routes.product, "product", "product");
  const search = compileRoute(source.routes.search, "search", "search");
  const cart = compileRoute(source.routes.cart, "cart", "cart");
  const collections = source.routes.collections ? compileRoute(source.routes.collections, "collections", "store") : undefined;
  const story = source.routes.story ? compileRoute(source.routes.story, "story", "store") : undefined;
  const notFound = source.routes.notFound ? compileRoute(source.routes.notFound, "notFound", "store") : undefined;
  const routes = [shell, home, collection, product, search, cart, collections, story, notFound].filter((route): route is NonNullable<typeof route> => Boolean(route));
  const protectedNodes = routes.flatMap((route) => route.protectedNodes);
  const protectedSourceIds = routes.flatMap((route) => route.protectedSourceIds);
  const bundle: StorefrontBundleV1 = {
    schemaVersion: STOREFRONT_SCHEMA_VERSION,
    runtimeVersion: STOREFRONT_RUNTIME_VERSION,
    validationProfileVersion: STOREFRONT_VALIDATION_PROFILE_VERSION,
    source: { ...source.source } as StorefrontBundleV1["source"],
    concept: {
      name: source.concept.name,
      rationale: source.concept.rationale,
      noveltySignature: [...source.concept.noveltySignature],
    },
    designSystem: compileDesignSystem(source.designSystem, protectedNodes, protectedSourceIds),
    shell: shell.artifact,
    routes: {
      home: home.artifact,
      collection: collection.artifact,
      product: product.artifact,
      search: search.artifact,
      cart: cart.artifact,
      checkout: compileCheckout(source.routes.checkout),
      ...(collections ? { collections: collections.artifact } : {}),
      ...(story ? { story: story.artifact } : {}),
      ...(notFound ? { notFound: notFound.artifact } : {}),
    },
    assets: compileAssets(source.assets),
  };
  assertDesignTokenCoverage(bundle);
  const report = validateCompiledBundle(bundle);
  return { bundle, hash: hashCompiledBundle(bundle), report };
}

// Type-only sentinel: recipe source callers retain the versioned registry ID contract.
export type RecipeCompilerSource = Extract<StorefrontBundleSourceV1["source"], { kind: "recipe" }> & {
  templateId: StoreTemplateId;
};
