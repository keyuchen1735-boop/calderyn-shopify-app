import { Fragment, createElement, type ReactElement, type ReactNode } from "react";
import type {
  CheckoutRouteArtifact,
  CompiledBinding,
  CompiledElementNode,
  CompiledNode,
  PublicDataRef,
  RouteArtifact,
  RouteTarget,
  CompiledStorefrontRouteId,
  StorefrontBundleV1,
  StorefrontRouteId,
  StoreTemplateId,
  TrustedSlotManifest,
} from "~/lib/storefront-bundle/types";
import { isAllowedCompiledTag } from "~/lib/storefront-compiler/html";
import { getStoreTemplate, isStoreTemplateId } from "~/lib/storefront-bundle/registry";
import { CheckoutIslands } from "./checkout-islands";
import { storefrontDesignSystemCss } from "./curated-fonts";
import type {
  PublicCart,
  PublicMedia,
  PublicMoney,
  PublicPresentationData,
  PublicProduct,
  PublicVariant,
} from "./public-data.server";
import { TrustedSlotHost } from "./trusted-slots";

export type { PublicPresentationData } from "./public-data.server";

type ScopeValue =
  | PublicPresentationData
  | PublicProduct
  | PublicVariant
  | PublicMedia
  | PublicCart["lines"][number];

interface RenderContext {
  data: PublicPresentationData;
  bindings: Map<string, CompiledBinding[]>;
  slots: Map<string, TrustedSlotManifest>;
  scopes: Map<string, ScopeValue>;
  currentScopeId: string;
  instancePath: readonly string[];
  instanceSuffix?: string;
  mode: "public" | "preview";
  previewTemplateId?: StoreTemplateId;
  assetUrls: ReadonlyMap<string, string>;
  productPlaceholderUrl?: string;
  visualLayer?: StorefrontVisualPlacement;
}

export interface StorefrontVisualPlacement {
  hostNodeId: string;
  fallbackNodeId: string;
}

const EMPTY_MEDIA_DATA_URL = "data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 8 10%22%3E%3Crect width=%228%22 height=%2210%22 fill=%22%23e7e5e4%22/%3E%3Cpath d=%22M0 8l2.4-2.8 1.4 1.5 1.5-1.9L8 8.1V10H0z%22 fill=%22%23a8a29e%22/%3E%3Ccircle cx=%226%22 cy=%223%22 r=%221%22 fill=%22%23fafaf9%22/%3E%3C/svg%3E";

function StorefrontStyle({ nonce, css, kind }: { nonce: string; css: string; kind: string }): ReactElement {
  // CSS reaches this component only after compiler validation. Raw style text is
  // required because HTML entities are not decoded inside a browser's style node.
  if (/<\/style/i.test(css)) throw new Error("Unsafe storefront CSS style end tag");
  return <style nonce={nonce} data-cd-bundle-style={kind} dangerouslySetInnerHTML={{ __html: css }} />;
}

const PATHS: Record<CompiledStorefrontRouteId | "account" | "policy", string> = {
  home: "/storefront",
  collection: "/storefront/collections",
  product: "/storefront/products",
  search: "/storefront/search",
  cart: "/storefront/cart",
  checkout: "/storefront/checkout",
  account: "/storefront/account",
  policy: "/storefront/policies",
  collections: "/storefront/collections",
  story: "/storefront/story",
  notFound: "/storefront",
};

function rootValue(data: PublicPresentationData, path: string): unknown {
  if (path === "store.name") return data.store.name;
  if (path === "store.logo") return data.store.logo;
  if (path === "store.policyLinks") return data.policyLinks;
  if (path === "store.socialLinks") return [];
  if (path.startsWith("collection.")) return objectValue(data.collection, path.slice("collection.".length));
  if (path.startsWith("product.")) return objectValue(data.product, path.slice("product.".length));
  if (path.startsWith("variant.")) return objectValue(data.product?.variants[0] ?? null, path.slice("variant.".length));
  // A visitor without a cart still has a real count of zero — "Bag ()" is not a
  // rendering option, so the missing-cart case resolves to 0 rather than null.
  if (path === "cart.count") return data.cart?.count ?? 0;
  if (path.startsWith("cart.")) return objectValue(data.cart, path.slice("cart.".length));
  if (path.startsWith("search.")) return objectValue(data.search, path.slice("search.".length));
  return null;
}

function objectValue(value: unknown, field: string): unknown {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (field === "id" || field === "handle" || field === "title" || field === "description" ||
      field === "images" || field === "primaryImage" || field === "price" || field === "compareAtPrice" ||
      field === "availability" || field === "image" || field === "productCount" || field === "count" ||
      field === "lines" || field === "subtotal" || field === "discounts" || field === "total" ||
      field === "query" || field === "results" || field === "nextCursor" || field === "quantity" ||
      field === "unitPrice") return record[field] ?? null;
  return null;
}

function scopedValue(scope: ScopeValue | undefined, path: string): unknown {
  if (!scope) return null;
  if ("url" in scope && "alt" in scope) {
    if (path === "product.primaryImage" || path === "product.title") return scope;
    return null;
  }
  const [, field = ""] = path.split(".", 2);
  return objectValue(scope, field);
}

function resolveRef(ref: PublicDataRef, context: RenderContext): unknown {
  if (ref.kind === "literal") return ref.value;
  if (ref.kind !== "data") return null;
  return ref.scopeId === "root"
    ? rootValue(context.data, ref.path)
    : scopedValue(context.scopes.get(ref.scopeId), ref.path);
}

function isMoney(value: unknown): value is PublicMoney {
  return value !== null && typeof value === "object" &&
    typeof (value as PublicMoney).cents === "number" && typeof (value as PublicMoney).currency === "string";
}

function formatBinding(binding: CompiledBinding, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (binding.kind === "money") {
    if (!isMoney(value)) return null;
    return new Intl.NumberFormat("en-US", { style: "currency", currency: value.currency }).format(value.cents / 100);
  }
  if (binding.kind === "src") {
    const candidate = typeof value === "string" ? value : (value as PublicMedia | null)?.url;
    if (!candidate || (candidate.startsWith("/") && candidate.startsWith("//"))) return null;
    if (candidate.startsWith("/")) return candidate;
    try {
      const url = new URL(candidate);
      return url.protocol === "https:" ? url.toString() : null;
    } catch {
      return null;
    }
  }
  if (binding.kind === "alt") {
    const candidate = typeof value === "string" ? value : (value as PublicMedia | null)?.alt;
    return typeof candidate === "string" ? candidate : "";
  }
  if (binding.kind === "text" && binding.ref.kind === "data" && binding.ref.scopeId !== "root" &&
      binding.ref.path === "product.description" && typeof value === "string") {
    const description = value.trim();
    return description.length > 160 ? `${description.slice(0, 159).trimEnd()}…` : description;
  }
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : null;
}

function safeAssetUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function assetUrlsForBundle(
  bundle: StorefrontBundleV1,
  customAssetUrls: Readonly<Record<string, string>> | undefined,
): ReadonlyMap<string, string> {
  const urls = new Map<string, string>();
  for (const asset of bundle.assets.entries) {
    if (bundle.source.kind === "recipe") {
      const extension = { "image/webp": "webp", "video/webm": "webm", "video/mp4": "mp4" }[asset.mediaType];
      if (extension) {
        urls.set(asset.key, safeAssetUrl(customAssetUrls?.[asset.key]) ??
          `/storefront-recipes/${bundle.source.templateId}/${asset.contentHash}.${extension}`);
      }
      continue;
    }
    if (!new Set(["image/avif", "image/webp", "image/png", "image/jpeg", "video/webm", "video/mp4"]).has(asset.mediaType)) continue;
    const resolved = safeAssetUrl(customAssetUrls?.[asset.key]);
    if (resolved) urls.set(asset.key, resolved);
  }
  return urls;
}

function reactAttributeName(name: string): string {
  if (name === "class") return "className";
  if (name === "for") return "htmlFor";
  if (name === "tabindex") return "tabIndex";
  if (name === "autoplay") return "autoPlay";
  if (name === "playsinline") return "playsInline";
  return name;
}

function repeatValues(node: CompiledElementNode, data: PublicPresentationData): ScopeValue[] {
  switch (node.repeat?.source) {
    case "collection.products": return data.collection?.products ?? [];
    case "featured.products": return data.featuredProducts;
    case "related.products": return data.relatedProducts;
    case "search.results": return data.search?.results ?? [];
    case "cart.lines": return data.cart?.lines ?? [];
    case "product.images": return data.product?.images ?? [];
    case "product.variants": return data.product?.variants ?? [];
    default: return [];
  }
}

function routeRepeatIsEmpty(data: PublicPresentationData): boolean {
  if (data.collection) return data.collection.products.length === 0;
  if (data.search) return data.search.results.length === 0;
  if (data.cart) return data.cart.lines.length === 0;
  return data.featuredProducts.length === 0;
}

function itemKey(value: ScopeValue, index: number): string {
  if ("id" in value && typeof value.id === "string") return value.id;
  if ("url" in value && typeof value.url === "string") return value.url;
  return String(index);
}

function instanceSuffix(path: readonly string[]): string {
  const encoded = JSON.stringify(path.map((part) => [part.length, part]));
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < encoded.length; index += 1) {
    const code = encoded.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ code, 0x85ebca6b);
  }
  return `i-${(left >>> 0).toString(36)}${(right >>> 0).toString(36)}`;
}

function authorityKeyForSlot(slot: TrustedSlotManifest, context: RenderContext): string {
  if (slot.kind === "bundleBuilder") return "bundle:catalog";
  const scope = slot.scopeId && slot.scopeId !== "root" ? context.scopes.get(slot.scopeId) : undefined;
  if (slot.kind === "cartLineControls") {
    if (slot.scopeId === context.currentScopeId && scope && "quantity" in scope && typeof scope.id === "string") {
      return `cartLine:${scope.id}`;
    }
    throw new Error(`Trusted slot ${slot.id} requires an exact cartLine repeat scope`);
  }
  if (scope && "handle" in scope && typeof scope.id === "string") return `product:${scope.id}`;
  if (scope && "quantity" in scope && typeof scope.id === "string") return `cartLine:${scope.id}`;
  if (scope && "available" in scope && !("handle" in scope) && typeof scope.id === "string") {
    return `variant:${scope.id}`;
  }
  if ((slot.kind === "cartSummary" || slot.kind === "cartDrawer") && context.data.cart) {
    return `cart:${context.data.cart.id}`;
  }
  if (slot.kind === "cartSummary" || slot.kind === "cartDrawer") return "cart:neutral";
  if (context.data.product) return `product:${context.data.product.id}`;
  throw new Error(`Trusted slot ${slot.id} has no public commerce authority`);
}

function targetHref(target: RouteTarget, context: RenderContext): string {
  if (context.mode === "preview") {
    const params = Object.fromEntries(
      Object.entries(target.params).flatMap(([key, ref]) => {
        if (!ref) return [];
        const value = resolveRef(ref, context);
        return typeof value === "string" || typeof value === "number" ? [[key, String(value)]] : [];
      }),
    );
    if (target.routeId === "account" || target.routeId === "policy") return "#";
    const previewRoute = new URLSearchParams({ route: target.routeId });
    if (context.previewTemplateId) previewRoute.set("template", context.previewTemplateId);
    if (params.handle) previewRoute.set("handle", params.handle);
    if (params.query) previewRoute.set("q", params.query);
    return `/dashboard/store/preview?${previewRoute.toString()}`;
  }
  let path = PATHS[target.routeId];
  const params = Object.fromEntries(
    Object.entries(target.params).flatMap(([key, ref]) => {
      if (!ref) return [];
      const value = resolveRef(ref, context);
      return typeof value === "string" || typeof value === "number" ? [[key, String(value)]] : [];
    }),
  );
  if (target.routeId === "collection") {
    const handle = params.handle || context.data.collection?.handle ||
      context.data.search?.facets.collections.find(({ value }) => value.length > 0)?.value || "all";
    return `${path}/${encodeURIComponent(handle)}`;
  }
  if (target.routeId === "product" && params.handle) {
    path += `/${encodeURIComponent(params.handle)}`;
  } else if (target.routeId === "policy" && params.policyId) {
    path += `/${encodeURIComponent(params.policyId)}`;
  } else if (target.routeId === "search" && params.query) {
    path += `?q=${encodeURIComponent(params.query)}`;
  }
  return path;
}

function renderOne(node: CompiledNode, context: RenderContext, key: string): ReactNode {
  if (node.kind === "text") return node.value;
  if (!isAllowedCompiledTag(node.tag)) throw new Error(`Unsupported compiled tag ${node.tag}`);
  if (node.attributes["data-cd-empty-state"] !== undefined && !routeRepeatIsEmpty(context.data)) return null;

  if (node.trustedSlotId) {
    const slot = context.slots.get(node.trustedSlotId);
    if (!slot) throw new Error(`Missing trusted slot manifest ${node.trustedSlotId}`);
    const instanceId = context.instanceSuffix ? `${slot.id}-${context.instanceSuffix}` : slot.id;
    return (
      <TrustedSlotHost
        key={key}
        slot={slot}
        instanceId={instanceId}
        compilerId={node.id}
        authorityKey={authorityKeyForSlot(slot, context)}
      />
    );
  }

  const props: Record<string, unknown> = { key };
  for (const [name, value] of Object.entries(node.attributes)) {
    const reactName = reactAttributeName(name);
    if (node.tag === "video" && ["muted", "autoplay", "playsinline", "loop"].includes(name)) {
      props[reactName] = value === "";
    } else if (reactName === "value" && (node.tag === "input" || node.tag === "select" || node.tag === "textarea")) {
      props.defaultValue = value;
    } else {
      props[reactName] = value;
    }
  }
  if (context.visualLayer?.hostNodeId === node.id) {
    props["data-cd-visual-host"] = "";
  }
  if (context.visualLayer?.fallbackNodeId === node.id) props["data-cd-visual-fallback"] = "";
  const assetKey = node.attributes["data-cd-asset-key"];
  if ((node.tag === "img" || node.tag === "source") && assetKey) {
    const assetUrl = context.assetUrls.get(assetKey);
    if (assetUrl) props.src = assetUrl;
  }
  const posterAssetKey = node.attributes["data-cd-poster-asset-key"];
  if (node.tag === "video" && posterAssetKey) {
    const posterUrl = context.assetUrls.get(posterAssetKey);
    if (posterUrl) props.poster = posterUrl;
  }
  props.id = context.instanceSuffix ? `${node.id}-${context.instanceSuffix}` : node.id;
  props["data-cd-compiler-id"] = node.id;
  if (context.instanceSuffix) props["data-cd-instance"] = context.instanceSuffix;
  if (node.repeat && context.instanceSuffix) props["data-cd-repeat-owner"] = "true";
  if (node.routeTarget) props.href = targetHref(node.routeTarget, context);

  const nodeBindings = context.bindings.get(node.id) ?? [];
  let missingBoundImage = false;
  let missingBoundProductImage = false;
  let children: ReactNode[];
  if (node.attributes["data-cd-platform-content"] === "policyLinks") {
    const policyIds = new Set(["privacy", "terms", "refund", "shipping"]);
    children = context.data.policyLinks.flatMap((policy, index) => {
      const title = policy.title.trim();
      if (!policyIds.has(policy.id) || title.length === 0 || title.length > 120) return [];
      const href = context.mode === "preview" ? "#" : `${PATHS.policy}/${policy.id}`;
      return [createElement("a", { key: `${key}-policy-${policy.id}-${index}`, href }, title)];
    });
  } else {
    children = node.children.map((child, index) => renderNode(child, context, `${key}-${index}`));
  }
  for (const binding of nodeBindings) {
    const formatted = formatBinding(binding, resolveRef(binding.ref, context));
    if (binding.kind === "text" || binding.kind === "money") children = formatted === null ? [] : [formatted];
    else if (binding.kind === "src" && formatted !== null) props.src = formatted;
    else if (binding.kind === "src" && node.tag === "img") {
      missingBoundImage = true;
      missingBoundProductImage = binding.ref.kind === "data" && binding.ref.path === "product.primaryImage";
    }
    else if (binding.kind === "alt") props.alt = formatted ?? "";
  }
  if (node.tag === "img" && missingBoundImage && props.src === undefined) {
    props.src = missingBoundProductImage
      ? context.productPlaceholderUrl ?? EMPTY_MEDIA_DATA_URL
      : EMPTY_MEDIA_DATA_URL;
    props.alt = "";
    props["aria-hidden"] = true;
    props["data-cd-media-fallback"] = "true";
  }
  return createElement(node.tag, props, ...children);
}

function renderNode(node: CompiledNode, context: RenderContext, key: string): ReactNode {
  if (node.kind !== "element" || !node.repeat) return renderOne(node, context, key);
  return repeatValues(node, context.data).map((value, index) => {
    const rawKey = itemKey(value, index);
    const path = [...context.instancePath, node.repeat!.scopeId, rawKey];
    const scopes = new Map(context.scopes);
    scopes.set(node.repeat!.scopeId, value);
    return renderOne(node, {
      ...context,
      scopes,
      currentScopeId: node.repeat!.scopeId,
      instancePath: path,
      instanceSuffix: instanceSuffix(path),
    }, `${key}-${rawKey}`);
  });
}

function contextFor(
  treeBindings: readonly CompiledBinding[],
  trustedSlots: readonly TrustedSlotManifest[],
  data: PublicPresentationData,
  mode: "public" | "preview" = "public",
  assetUrls: ReadonlyMap<string, string> = new Map(),
  previewTemplateId?: StoreTemplateId,
  visualLayer?: StorefrontVisualPlacement,
  productPlaceholderUrl?: string,
): RenderContext {
  const bindings = new Map<string, CompiledBinding[]>();
  for (const binding of treeBindings) {
    const target = bindings.get(binding.targetId);
    if (target) target.push(binding);
    else bindings.set(binding.targetId, [binding]);
  }
  return {
    data,
    bindings,
    slots: new Map(trustedSlots.map((slot) => [slot.id, slot])),
    scopes: new Map([["root", data]]),
    currentScopeId: "root",
    instancePath: [],
    mode,
    previewTemplateId,
    assetUrls,
    productPlaceholderUrl,
    visualLayer,
  };
}

function renderTree(
  tree: readonly CompiledNode[],
  bindings: readonly CompiledBinding[],
  trustedSlots: readonly TrustedSlotManifest[],
  data: PublicPresentationData,
  mode: "public" | "preview" = "public",
  assetUrls: ReadonlyMap<string, string> = new Map(),
  previewTemplateId?: StoreTemplateId,
  visualLayer?: StorefrontVisualPlacement,
  productPlaceholderUrl?: string,
): ReactNode[] {
  const context = contextFor(bindings, trustedSlots, data, mode, assetUrls, previewTemplateId, visualLayer, productPlaceholderUrl);
  return tree.map((node, index) => renderNode(node, context, `node-${index}`));
}

function PlatformNotFound({ kind }: { kind: "product" | "collection" }) {
  return (
    <main data-cd-platform-error="not-found">
      <h1>{kind === "product" ? "Product not found" : "Collection not found"}</h1>
      <p>The requested page is unavailable.</p>
    </main>
  );
}

export interface RenderStorefrontRouteInput {
  routeId: Exclude<StorefrontRouteId, "checkout">;
  artifact: RouteArtifact;
  data: PublicPresentationData;
  nonce: string;
  assetUrls?: ReadonlyMap<string, string>;
}

export function renderStorefrontRoute(input: RenderStorefrontRouteInput): {
  status: 200 | 404;
  element: ReactElement;
} {
  if (input.data.notFound && (input.routeId === "product" || input.routeId === "collection")) {
    return { status: 404, element: <PlatformNotFound kind={input.data.notFound.kind} /> };
  }
  return {
    status: 200,
    element: (
      <div data-cd-bundle={input.routeId} data-cd-bundle-route={input.routeId}>
        {input.artifact.css ? <StorefrontStyle nonce={input.nonce} css={input.artifact.css} kind={input.routeId} /> : null}
        {renderTree(input.artifact.tree, input.artifact.bindings, input.artifact.trustedSlots, input.data, "public", input.assetUrls)}
      </div>
    ),
  };
}

export interface RenderCheckoutRouteInput {
  artifact: CheckoutRouteArtifact;
  data: PublicPresentationData;
  nonce: string;
  platformContent?: ReactNode;
  assetUrls?: ReadonlyMap<string, string>;
}

export function renderCheckoutRoute({ artifact, data, nonce, platformContent, assetUrls }: RenderCheckoutRouteInput): ReactElement {
  return (
    <Fragment>
      {artifact.decorativeCss ? <StorefrontStyle nonce={nonce} css={artifact.decorativeCss} kind="checkout" /> : null}
      <div data-cd-bundle="checkout" data-cd-checkout-decoration>
        {renderTree(artifact.decorativeTree, artifact.bindings, [], data, "public", assetUrls)}
      </div>
      <CheckoutIslands layout={artifact.layout}>{platformContent}</CheckoutIslands>
    </Fragment>
  );
}

export interface RenderStorefrontSurfaceInput {
  bundle: StorefrontBundleV1;
  routeId: CompiledStorefrontRouteId;
  data: PublicPresentationData;
  nonce: string;
  mode: "public" | "preview";
  checkoutContent?: ReactNode;
  customAssetUrls?: Readonly<Record<string, string>>;
  visualLayerPlacement?: StorefrontVisualPlacement | null;
}

export function splitShellTree(tree: readonly CompiledNode[]): { beforeRoute: CompiledNode[]; afterRoute: CompiledNode[] } {
  const beforeRoute: CompiledNode[] = [];
  const afterRoute: CompiledNode[] = [];
  for (const node of tree) {
    if (node.kind === "element" && node.tag === "footer") afterRoute.push(node);
    else beforeRoute.push(node);
  }
  return { beforeRoute, afterRoute };
}

export function isRuntime1RenderData(value: unknown): value is {
  runtime: 1;
  bundle: StorefrontBundleV1;
  data: PublicPresentationData;
  nonce: string;
  routeId: CompiledStorefrontRouteId;
  visualLayerPlacement: StorefrontVisualPlacement | null;
} {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.runtime === 1 && typeof record.nonce === "string" &&
    Boolean(record.bundle) && typeof record.bundle === "object" &&
    Boolean(record.data) && typeof record.data === "object";
}

/** Render the immutable shell and selected route from the same resolved bundle object. */
export function renderStorefrontSurface({ bundle, routeId, data, nonce, mode, checkoutContent, customAssetUrls, visualLayerPlacement }: RenderStorefrontSurfaceInput): ReactElement {
  const assetUrls = assetUrlsForBundle(bundle, customAssetUrls ?? data.storefrontAssetUrls);
  const recipeSource = bundle.source.kind === "recipe" ? bundle.source : null;
  const productPlaceholderUrl = recipeSource && isStoreTemplateId(recipeSource.templateId)
    ? assetUrls.get(getStoreTemplate(recipeSource.templateId).versions
      .find(({ templateVersion }) => templateVersion === recipeSource.templateVersion)
      ?.productPlaceholderAssetKey ?? "")
    : undefined;
  const previewTemplateId = mode === "preview" && bundle.source.kind === "recipe" ? bundle.source.templateId : undefined;
  const shellTree = splitShellTree(bundle.shell.tree);
  const visualLayer = visualLayerPlacement ?? null;
  let routeResult: ReactElement;
  if (routeId === "checkout") {
    routeResult = (
      <div data-cd-bundle="checkout" data-cd-bundle-route="checkout">
        {renderCheckoutRoute({
          artifact: bundle.routes.checkout,
          data,
          nonce,
          assetUrls,
          platformContent: checkoutContent ?? (mode === "preview" ? <p data-cd-preview-checkout="simulated">Checkout simulation</p> : undefined),
        })}
      </div>
    );
  } else {
    const route = bundle.routes[routeId];
    if (!route) throw new Error(`Missing compiled route ${routeId}`);
    routeResult = (
      <div data-cd-bundle={routeId} data-cd-bundle-route={routeId}>
        {route.css ? <StorefrontStyle nonce={nonce} css={route.css} kind={routeId} /> : null}
        {renderTree(route.tree, route.bindings, route.trustedSlots, data, mode, assetUrls, previewTemplateId, visualLayer ?? undefined, productPlaceholderUrl)}
      </div>
    );
  }
  return (
    <div data-cd-bundle="global" data-cd-bundle-runtime="1" data-cd-bundle-source={bundle.source.kind}>
      <StorefrontStyle nonce={nonce} css={storefrontDesignSystemCss(bundle.designSystem, recipeSource?.templateId, recipeSource?.templateVersion)} kind="tokens" />
      {bundle.designSystem.globalCss ? <StorefrontStyle nonce={nonce} css={bundle.designSystem.globalCss} kind="global" /> : null}
      <div data-cd-bundle="shell" data-cd-bundle-shell={routeId}>
        {bundle.shell.css ? <StorefrontStyle nonce={nonce} css={bundle.shell.css} kind="shell" /> : null}
        {renderTree(shellTree.beforeRoute, bundle.shell.bindings, bundle.shell.trustedSlots, data, mode, assetUrls, previewTemplateId, visualLayer ?? undefined, productPlaceholderUrl)}
        {routeResult}
        {renderTree(shellTree.afterRoute, bundle.shell.bindings, bundle.shell.trustedSlots, data, mode, assetUrls, previewTemplateId, visualLayer ?? undefined, productPlaceholderUrl)}
      </div>
    </div>
  );
}
