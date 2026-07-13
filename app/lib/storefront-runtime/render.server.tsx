import { Fragment, createElement, type ReactElement, type ReactNode } from "react";
import { createHash } from "node:crypto";
import type {
  CheckoutRouteArtifact,
  CompiledBinding,
  CompiledElementNode,
  CompiledNode,
  PublicDataRef,
  RouteArtifact,
  RouteTarget,
  StorefrontRouteId,
  TrustedSlotManifest,
} from "~/lib/storefront-bundle/types";
import { isAllowedCompiledTag } from "~/lib/storefront-compiler/html";
import { CheckoutIslands } from "./checkout-islands";
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
}

const PATHS: Record<StorefrontRouteId | "account" | "policy", string> = {
  home: "/storefront",
  collection: "/storefront/collections",
  product: "/storefront/products",
  search: "/storefront/search",
  cart: "/storefront/cart",
  checkout: "/storefront/checkout",
  account: "/storefront/account",
  policy: "/storefront/policies",
};

function rootValue(data: PublicPresentationData, path: string): unknown {
  if (path === "store.name") return data.store.name;
  if (path === "store.logo") return data.store.logo;
  if (path === "store.policyLinks") return data.policyLinks;
  if (path === "store.socialLinks") return [];
  if (path.startsWith("collection.")) return objectValue(data.collection, path.slice("collection.".length));
  if (path.startsWith("product.")) return objectValue(data.product, path.slice("product.".length));
  if (path.startsWith("variant.")) return objectValue(data.product?.variants[0] ?? null, path.slice("variant.".length));
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
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : null;
}

function reactAttributeName(name: string): string {
  if (name === "class") return "className";
  if (name === "for") return "htmlFor";
  if (name === "tabindex") return "tabIndex";
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

function itemKey(value: ScopeValue, index: number): string {
  if ("id" in value && typeof value.id === "string") return value.id;
  if ("url" in value && typeof value.url === "string") return value.url;
  return String(index);
}

function instanceSuffix(path: readonly string[]): string {
  const encoded = JSON.stringify(path.map((part) => [part.length, part]));
  return `i-${createHash("sha256").update(encoded).digest("base64url").slice(0, 22)}`;
}

function authorityKeyForSlot(slot: TrustedSlotManifest, context: RenderContext): string {
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
  if (context.data.product) return `product:${context.data.product.id}`;
  throw new Error(`Trusted slot ${slot.id} has no public commerce authority`);
}

function targetHref(target: RouteTarget, context: RenderContext): string {
  let path = PATHS[target.routeId];
  const params = Object.fromEntries(
    Object.entries(target.params).flatMap(([key, ref]) => {
      if (!ref) return [];
      const value = resolveRef(ref, context);
      return typeof value === "string" || typeof value === "number" ? [[key, String(value)]] : [];
    }),
  );
  if ((target.routeId === "product" || target.routeId === "collection") && params.handle) {
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

  if (node.trustedSlotId) {
    const slot = context.slots.get(node.trustedSlotId);
    if (!slot) throw new Error(`Missing trusted slot manifest ${node.trustedSlotId}`);
    const instanceId = context.instanceSuffix ? `${slot.id}-${context.instanceSuffix}` : slot.id;
    return (
      <TrustedSlotHost
        key={key}
        slot={slot}
        instanceId={instanceId}
        authorityKey={authorityKeyForSlot(slot, context)}
      />
    );
  }

  const props: Record<string, unknown> = { key };
  for (const [name, value] of Object.entries(node.attributes)) props[reactAttributeName(name)] = value;
  props.id = context.instanceSuffix ? `${node.id}-${context.instanceSuffix}` : node.id;
  if (context.instanceSuffix) props["data-cd-instance"] = context.instanceSuffix;
  if (node.routeTarget) props.href = targetHref(node.routeTarget, context);

  const nodeBindings = context.bindings.get(node.id) ?? [];
  let children: ReactNode[] = node.children.map((child, index) => renderNode(child, context, `${key}-${index}`));
  for (const binding of nodeBindings) {
    const formatted = formatBinding(binding, resolveRef(binding.ref, context));
    if (binding.kind === "text" || binding.kind === "money") children = formatted === null ? [] : [formatted];
    else if (binding.kind === "src" && formatted !== null) props.src = formatted;
    else if (binding.kind === "alt") props.alt = formatted ?? "";
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
  };
}

function renderTree(
  tree: readonly CompiledNode[],
  bindings: readonly CompiledBinding[],
  trustedSlots: readonly TrustedSlotManifest[],
  data: PublicPresentationData,
): ReactNode[] {
  const context = contextFor(bindings, trustedSlots, data);
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
      <div data-cd-bundle-route={input.routeId}>
        {input.artifact.css ? <style nonce={input.nonce} data-cd-bundle-style={input.routeId}>{input.artifact.css}</style> : null}
        {renderTree(input.artifact.tree, input.artifact.bindings, input.artifact.trustedSlots, input.data)}
      </div>
    ),
  };
}

export interface RenderCheckoutRouteInput {
  artifact: CheckoutRouteArtifact;
  data: PublicPresentationData;
  nonce: string;
}

export function renderCheckoutRoute({ artifact, data, nonce }: RenderCheckoutRouteInput): ReactElement {
  return (
    <Fragment>
      {artifact.decorativeCss ? <style nonce={nonce} data-cd-bundle-style="checkout">{artifact.decorativeCss}</style> : null}
      <div data-cd-checkout-decoration>
        {renderTree(artifact.decorativeTree, artifact.bindings, [], data)}
      </div>
      <CheckoutIslands layout={artifact.layout} />
    </Fragment>
  );
}
