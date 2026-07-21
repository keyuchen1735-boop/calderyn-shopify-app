import {
  isPublicBindingPath,
  type CompiledBinding,
  type CompiledBindingKind,
  type CompiledRepeat,
  type CompiledRepeatSource,
  type PublicBindingPath,
  type PublicDataRef,
  type RouteTarget,
} from "../storefront-bundle/types";

export class CompilerError extends Error {
  readonly code: string;
  readonly path: string;

  constructor(code: string, message: string, path = "source") {
    super(`${code}: ${message}`);
    this.name = "CompilerError";
    this.code = code;
    this.path = path;
  }
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export type BindingScopeKind = "store" | "collection" | "product" | "variant" | "cart" | "cartLine" | "search" | "image" | "fact";

export interface BindingScope {
  id: string;
  kind: BindingScopeKind;
}

const REPEAT_SOURCES: Readonly<Record<CompiledRepeatSource, CompiledRepeat["itemKind"]>> = {
  "collection.products": "product",
  "featured.products": "product",
  "featured.collections": "collection",
  "related.products": "product",
  "search.results": "product",
  "cart.lines": "cartLine",
  "product.images": "image",
  "product.variants": "variant",
  "product.facts": "fact",
};

const REPEAT_KEYS: Readonly<Record<CompiledRepeatSource, PublicBindingPath>> = {
  "collection.products": "product.id",
  "featured.products": "product.id",
  "featured.collections": "collection.id",
  "related.products": "product.id",
  "search.results": "product.id",
  "cart.lines": "cartLine.id",
  "product.images": "product.primaryImage",
  "product.variants": "variant.id",
  "product.facts": "fact.id",
};

function pathOwner(path: PublicBindingPath): BindingScopeKind {
  const dot = path.indexOf(".");
  return path.slice(0, dot) as BindingScopeKind;
}

export function isPathVisible(path: PublicBindingPath, scope: BindingScope): boolean {
  const owner = pathOwner(path);
  if (owner === "store") return scope.id === "root";
  if (path === "cart.count" && scope.kind === "store") return scope.id === "root";
  if (owner === "product" && scope.kind === "image") return true;
  return owner === scope.kind;
}

export function compileDataRef(path: string, scope: BindingScope): Extract<PublicDataRef, { kind: "data" }> {
  if (!isPublicBindingPath(path)) {
    throw new CompilerError("binding.unsupported", `Unsupported public binding path ${JSON.stringify(path)}`);
  }
  if (!isPathVisible(path, scope)) {
    throw new CompilerError(
      "binding.scope",
      `Binding ${JSON.stringify(path)} is not visible from scope ${JSON.stringify(scope.id)}`,
    );
  }
  return { kind: "data", scopeId: scope.id, path };
}

export function compileBinding(
  id: string,
  targetId: string,
  kind: CompiledBindingKind,
  path: string,
  scope: BindingScope,
): CompiledBinding {
  const ref = compileDataRef(path, scope);
  if (!isBindingKindPathAllowed(kind, ref.path)) {
    throw new CompilerError("binding.type", `${kind} binding does not accept ${JSON.stringify(path)}`);
  }
  return { id, targetId, kind, ref };
}

const BINDING_PATHS: Readonly<Record<CompiledBindingKind, ReadonlySet<PublicBindingPath>>> = {
  text: new Set([
      "store.name", "collection.title", "collection.description", "collection.productCount", "product.title",
      "product.description", "product.availability", "variant.title", "variant.availability", "cart.count",
      "cartLine.title", "cartLine.quantity", "search.query",
      "fact.kind", "fact.label", "fact.value", "fact.unit",
  ]),
  money: new Set([
      "product.price", "product.compareAtPrice", "variant.price", "variant.compareAtPrice", "cart.subtotal",
      "cart.discounts", "cart.total", "cartLine.unitPrice", "cartLine.total",
  ]),
  src: new Set(["store.logo", "collection.image", "product.primaryImage"]),
  alt: new Set(["store.name", "collection.title", "product.title", "variant.title", "cartLine.title"]),
  href: new Set(["fact.url"]),
};

export function isBindingKindPathAllowed(kind: CompiledBindingKind, path: PublicBindingPath): boolean {
  return BINDING_PATHS[kind].has(path);
}

export const REPEAT_PARENT_KIND: Readonly<Record<CompiledRepeatSource, BindingScopeKind>> = {
  "collection.products": "collection",
  "featured.products": "store",
  "featured.collections": "store",
  "related.products": "product",
  "search.results": "search",
  "cart.lines": "cart",
  "product.images": "product",
  "product.variants": "product",
  "product.facts": "product",
};

export function compileRepeat(
  source: string,
  scopeId: string,
  parentScope: BindingScope,
  keyPath?: string,
): CompiledRepeat {
  if (!Object.hasOwn(REPEAT_SOURCES, source)) {
    throw new CompilerError("repeat.unsupported", `Unsupported repeat source ${JSON.stringify(source)}`);
  }
  const typedSource = source as CompiledRepeatSource;
  if (REPEAT_PARENT_KIND[typedSource] !== parentScope.kind) {
    throw new CompilerError("repeat.scope", `Repeat ${JSON.stringify(source)} is not visible from ${parentScope.kind} scope`);
  }
  const expectedKey = REPEAT_KEYS[typedSource];
  if (keyPath !== undefined && keyPath !== expectedKey) {
    throw new CompilerError(
      "repeat.key",
      `Repeat ${JSON.stringify(source)} must use key ${JSON.stringify(expectedKey)}`,
    );
  }
  return { scopeId, source: typedSource, itemKind: REPEAT_SOURCES[typedSource], keyPath: expectedKey };
}

export function scopeForRepeat(repeat: CompiledRepeat): BindingScope {
  return { id: repeat.scopeId, kind: repeat.itemKind };
}

const ROUTE_IDS = new Set(["home", "collection", "product", "search", "cart", "checkout", "collections", "story", "notFound", "account", "policy"]);
const PARAMS_BY_ROUTE: Readonly<Record<string, ReadonlySet<string>>> = {
  home: new Set(),
  collection: new Set(["handle"]),
  product: new Set(["handle"]),
  search: new Set(["query"]),
  cart: new Set(),
  checkout: new Set(),
  collections: new Set(),
  story: new Set(),
  notFound: new Set(),
  account: new Set(),
  policy: new Set(["policyId"]),
};

export function compileRouteTarget(
  routeId: string,
  rawParams: Readonly<Record<string, string>>,
  scope: BindingScope,
): RouteTarget {
  if (!ROUTE_IDS.has(routeId)) {
    throw new CompilerError("route.unsupported", `Unsupported route target ${JSON.stringify(routeId)}`);
  }
  const allowedParams = PARAMS_BY_ROUTE[routeId];
  const params: RouteTarget["params"] = {};
  for (const [param, value] of Object.entries(rawParams).sort(([a], [b]) => compareCodeUnits(a, b))) {
    if (!allowedParams?.has(param)) {
      throw new CompilerError("route.param", `Parameter ${JSON.stringify(param)} is not valid for route ${routeId}`);
    }
    if (param === "policyId") {
      if (!new Set(["privacy", "terms", "refund", "shipping"]).has(value)) {
        throw new CompilerError("route.policy", `Unsupported policy ID ${JSON.stringify(value)}`);
      }
      params.policyId = { kind: "literal", value };
      continue;
    }
    const ref = compileDataRef(value, scope);
    if (param === "handle") {
      const expectedPath = routeId === "product" ? "product.handle" : "collection.handle";
      if (ref.kind !== "data" || ref.path !== expectedPath) {
        throw new CompilerError("route.handle", `${routeId} handle must bind ${expectedPath}`);
      }
    }
    if (param === "query" && (ref.kind !== "data" || ref.path !== "search.query")) {
      throw new CompilerError("route.query", "Search query must bind search.query");
    }
    params[param as keyof RouteTarget["params"]] = ref;
  }
  return { routeId: routeId as RouteTarget["routeId"], params };
}
