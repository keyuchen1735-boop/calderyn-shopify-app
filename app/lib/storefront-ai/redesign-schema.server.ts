import {
  CURATED_FONT_IDS,
  type StorefrontRouteId,
} from "../storefront-bundle/types";
import type {
  CheckoutRouteSource,
  RouteSource,
  StorefrontBundleSourceV1,
} from "../storefront-compiler/compile";

export const REDESIGN_OUTPUT_CODE_POINT_CAP = 500_000;
export const REDESIGN_OUTPUT_BYTE_CAP = 1_000_000;
const SOURCE_TEXT_CAP = 120_000;
const DESCRIPTION_CAP = 2_000;
const ROUTE_IDS = ["home", "collection", "product", "search", "cart", "checkout"] as const;
const CAPABILITIES = ["navigation", "localState", "overlay", "catalogFiltering", "catalogSearch", "commerce"] as const;
const DATA_KINDS = ["storeIdentity", "policyLinks", "currentProduct", "currentCollection", "cart", "featuredProducts", "relatedProducts", "searchResults"] as const;

export interface StorefrontDesignPlan {
  concept: StorefrontBundleSourceV1["concept"];
  designSystem: StorefrontBundleSourceV1["designSystem"];
  routeBriefs: Record<"shell" | StorefrontRouteId, string>;
}

export type RedesignGroup =
  | { group: "shell_home"; shell: RouteSource; home: RouteSource }
  | { group: "catalog"; collection: RouteSource; product: RouteSource; search: RouteSource }
  | { group: "commerce"; cart: RouteSource; checkout: CheckoutRouteSource };

export interface StructuralRouteResponse {
  routeId: StorefrontRouteId;
  route: RouteSource | CheckoutRouteSource;
}

export interface RedesignRepairRequest {
  routeId: StorefrontRouteId;
  route: RouteSource | CheckoutRouteSource;
  diagnostics: Array<{ code: string; message: string; regionId?: string }>;
}

export interface RedesignRepairResponse {
  routeId: StorefrontRouteId;
  route: RouteSource | CheckoutRouteSource;
}

export interface RedesignProviderAudit {
  provider: "anthropic";
  model: string;
  inputTokens: number;
  outputTokens: number;
}

const stringSchema = (maxLength: number) => ({ type: "string", minLength: 1, maxLength } as const);
const objectSchema = (required: readonly string[], properties: Record<string, unknown>) => ({
  type: "object", additionalProperties: false, required, properties,
} as const);

const dataRequirementSchema = {
  oneOf: [
    objectSchema(["kind"], { kind: { type: "string", enum: DATA_KINDS.slice(0, 5) } }),
    objectSchema(["kind", "limit"], {
      kind: { type: "string", enum: DATA_KINDS.slice(5) },
      limit: { type: "integer", minimum: 1, maximum: 100 },
    }),
    objectSchema(["kind", "limit", "collectionHandle"], {
      kind: { type: "string", const: "featuredProducts" },
      limit: { type: "integer", minimum: 1, maximum: 100 },
      collectionHandle: stringSchema(160),
    }),
  ],
} as const;

export const ROUTE_SOURCE_SCHEMA = objectSchema(
  ["html", "css", "requiredData", "requiredCapabilities"],
  {
    html: stringSchema(SOURCE_TEXT_CAP),
    css: { type: "string", maxLength: SOURCE_TEXT_CAP },
    requiredData: { type: "array", maxItems: 8, items: dataRequirementSchema },
    requiredCapabilities: { type: "array", maxItems: CAPABILITIES.length, uniqueItems: true, items: { type: "string", enum: CAPABILITIES } },
    rootScopeKind: { type: "string", enum: ["store", "collection", "product", "search", "cart", "cartLine", "image", "variant"] },
  },
);

export const CHECKOUT_ROUTE_SOURCE_SCHEMA = objectSchema(["html", "css", "layout"], {
  html: stringSchema(SOURCE_TEXT_CAP),
  css: { type: "string", maxLength: SOURCE_TEXT_CAP },
  layout: objectSchema(["columnMode", "sectionOrder", "spacingTokenId", "surfaceTokenIds"], {
    columnMode: { type: "string", enum: ["single", "summaryAside", "summaryFirst"] },
    sectionOrder: {
      type: "array", minItems: 6, maxItems: 6, uniqueItems: true,
      items: { type: "string", enum: ["contact", "shipping", "delivery", "consent", "payment", "summary"] },
    },
    spacingTokenId: stringSchema(80),
    surfaceTokenIds: { type: "array", maxItems: 16, items: stringSchema(80) },
  }),
});

const conceptSchema = objectSchema(["name", "rationale", "noveltySignature"], {
  name: stringSchema(240),
  rationale: stringSchema(DESCRIPTION_CAP),
  noveltySignature: { type: "array", minItems: 1, maxItems: 12, uniqueItems: true, items: stringSchema(240) },
});

const designSystemSchema = objectSchema(
  ["displayFontId", "bodyFontId", "tokens", "breakpoints", "iconStyle", "motionStyle", "globalCss"],
  {
    displayFontId: { type: "string", enum: CURATED_FONT_IDS },
    bodyFontId: { type: "string", enum: CURATED_FONT_IDS },
    tokens: { type: "object", maxProperties: 80, additionalProperties: { type: "string", maxLength: 240 } },
    breakpoints: { type: "object", maxProperties: 12, additionalProperties: { type: "integer", minimum: 240, maximum: 3840 } },
    iconStyle: { type: "string", maxLength: 120 },
    motionStyle: { type: "string", maxLength: 120 },
    globalCss: { type: "string", maxLength: SOURCE_TEXT_CAP },
  },
);

const routeBriefsSchema = objectSchema(["shell", ...ROUTE_IDS], Object.fromEntries(
  ["shell", ...ROUTE_IDS].map((routeId) => [routeId, stringSchema(DESCRIPTION_CAP)]),
));

export const STOREFRONT_DESIGN_PLAN_SCHEMA = objectSchema(["concept", "designSystem", "routeBriefs"], {
  concept: conceptSchema,
  designSystem: designSystemSchema,
  routeBriefs: routeBriefsSchema,
});

function structuralRouteSchema(routeId: StorefrontRouteId) {
  return objectSchema(["routeId", "route"], {
    routeId: { type: "string", const: routeId },
    route: routeId === "checkout" ? CHECKOUT_ROUTE_SOURCE_SCHEMA : ROUTE_SOURCE_SCHEMA,
  });
}

export const STRUCTURAL_ROUTE_SCHEMAS = {
  home: structuralRouteSchema("home"),
  collection: structuralRouteSchema("collection"),
  product: structuralRouteSchema("product"),
  search: structuralRouteSchema("search"),
  cart: structuralRouteSchema("cart"),
  checkout: structuralRouteSchema("checkout"),
} as const;

export const REDESIGN_GROUP_SCHEMAS = {
  shell_home: objectSchema(["group", "shell", "home"], {
    group: { type: "string", const: "shell_home" }, shell: ROUTE_SOURCE_SCHEMA, home: ROUTE_SOURCE_SCHEMA,
  }),
  catalog: objectSchema(["group", "collection", "product", "search"], {
    group: { type: "string", const: "catalog" }, collection: ROUTE_SOURCE_SCHEMA, product: ROUTE_SOURCE_SCHEMA, search: ROUTE_SOURCE_SCHEMA,
  }),
  commerce: objectSchema(["group", "cart", "checkout"], {
    group: { type: "string", const: "commerce" }, cart: ROUTE_SOURCE_SCHEMA, checkout: CHECKOUT_ROUTE_SOURCE_SCHEMA,
  }),
} as const;

export const REDESIGN_REPAIR_RESPONSE_SCHEMAS = STRUCTURAL_ROUTE_SCHEMAS;

const diagnosticSchema = objectSchema(["code", "message"], {
  code: stringSchema(120), message: stringSchema(1_000), regionId: stringSchema(120),
});

function repairRequestSchema(routeId: StorefrontRouteId) {
  return objectSchema(["routeId", "route", "diagnostics"], {
    routeId: { type: "string", const: routeId },
    route: routeId === "checkout" ? CHECKOUT_ROUTE_SOURCE_SCHEMA : ROUTE_SOURCE_SCHEMA,
    diagnostics: { type: "array", minItems: 1, maxItems: 20, items: diagnosticSchema },
  });
}

export const REDESIGN_REPAIR_REQUEST_SCHEMAS = {
  home: repairRequestSchema("home"), collection: repairRequestSchema("collection"),
  product: repairRequestSchema("product"), search: repairRequestSchema("search"),
  cart: repairRequestSchema("cart"), checkout: repairRequestSchema("checkout"),
} as const;

export const REDESIGN_PROVIDER_AUDIT_SCHEMA = objectSchema(["provider", "model", "inputTokens", "outputTokens"], {
  provider: { type: "string", const: "anthropic" }, model: stringSchema(240),
  inputTokens: { type: "integer", minimum: 0 }, outputTokens: { type: "integer", minimum: 0 },
});

function invalid(): never {
  throw new Error("Invalid storefront redesign response");
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}

function bounded(value: unknown, cap: number, allowEmpty = false): value is string {
  return typeof value === "string" && (allowEmpty || value.trim().length > 0) && Array.from(value).length <= cap;
}

function integer(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && Number(value) >= min && Number(value) <= max;
}

function parseDataRequirement(value: unknown): RouteSource["requiredData"][number] {
  const item = record(value);
  if (!item || typeof item.kind !== "string" || !DATA_KINDS.includes(item.kind as typeof DATA_KINDS[number])) invalid();
  if (["storeIdentity", "policyLinks", "currentProduct", "currentCollection", "cart"].includes(item.kind)) {
    if (!exact(item, ["kind"])) invalid();
    return item as RouteSource["requiredData"][number];
  }
  if (!integer(item.limit, 1, 100)) invalid();
  if (item.kind === "featuredProducts") {
    if (!exact(item, ["kind", "limit"], ["collectionHandle"]) || (item.collectionHandle !== undefined && !bounded(item.collectionHandle, 160))) invalid();
  } else if (!exact(item, ["kind", "limit"])) invalid();
  return item as RouteSource["requiredData"][number];
}

function parseRoute(value: unknown): RouteSource {
  const item = record(value);
  if (!item || !exact(item, ["html", "css", "requiredData", "requiredCapabilities"], ["rootScopeKind"])
    || !bounded(item.html, SOURCE_TEXT_CAP) || !bounded(item.css, SOURCE_TEXT_CAP, true)
    || !Array.isArray(item.requiredData) || item.requiredData.length > 8
    || !Array.isArray(item.requiredCapabilities) || item.requiredCapabilities.length > CAPABILITIES.length
    || new Set(item.requiredCapabilities).size !== item.requiredCapabilities.length
    || !item.requiredCapabilities.every((capability) => typeof capability === "string" && CAPABILITIES.includes(capability as typeof CAPABILITIES[number]))
    || (item.rootScopeKind !== undefined && !["store", "collection", "product", "search", "cart", "cartLine", "image", "variant"].includes(String(item.rootScopeKind)))) invalid();
  return {
    html: item.html,
    css: item.css,
    requiredData: item.requiredData.map(parseDataRequirement),
    requiredCapabilities: item.requiredCapabilities as RouteSource["requiredCapabilities"],
    ...(item.rootScopeKind !== undefined ? { rootScopeKind: item.rootScopeKind as RouteSource["rootScopeKind"] } : {}),
  };
}

function parseCheckout(value: unknown): CheckoutRouteSource {
  const item = record(value);
  const layout = record(item?.layout);
  if (!item || !exact(item, ["html", "css", "layout"]) || !bounded(item.html, SOURCE_TEXT_CAP)
    || !bounded(item.css, SOURCE_TEXT_CAP, true) || !layout
    || !exact(layout, ["columnMode", "sectionOrder", "spacingTokenId", "surfaceTokenIds"])
    || !["single", "summaryAside", "summaryFirst"].includes(String(layout.columnMode))
    || !Array.isArray(layout.sectionOrder) || layout.sectionOrder.length !== 6 || new Set(layout.sectionOrder).size !== 6
    || !layout.sectionOrder.every((section) => ["contact", "shipping", "delivery", "consent", "payment", "summary"].includes(String(section)))
    || !bounded(layout.spacingTokenId, 80) || !Array.isArray(layout.surfaceTokenIds) || layout.surfaceTokenIds.length > 16
    || !layout.surfaceTokenIds.every((token) => bounded(token, 80))) invalid();
  return item as unknown as CheckoutRouteSource;
}

function parseConcept(value: unknown): StorefrontDesignPlan["concept"] {
  const item = record(value);
  if (!item || !exact(item, ["name", "rationale", "noveltySignature"])
    || !bounded(item.name, 240) || !bounded(item.rationale, DESCRIPTION_CAP)
    || !Array.isArray(item.noveltySignature) || item.noveltySignature.length === 0 || item.noveltySignature.length > 12
    || new Set(item.noveltySignature).size !== item.noveltySignature.length
    || !item.noveltySignature.every((part) => bounded(part, 240))) invalid();
  return item as unknown as StorefrontDesignPlan["concept"];
}

function parseDesignSystem(value: unknown): StorefrontDesignPlan["designSystem"] {
  const item = record(value);
  const tokens = record(item?.tokens);
  const breakpoints = record(item?.breakpoints);
  if (!item || !exact(item, ["displayFontId", "bodyFontId", "tokens", "breakpoints", "iconStyle", "motionStyle", "globalCss"])
    || !CURATED_FONT_IDS.includes(item.displayFontId as typeof CURATED_FONT_IDS[number])
    || !CURATED_FONT_IDS.includes(item.bodyFontId as typeof CURATED_FONT_IDS[number])
    || !tokens || Object.keys(tokens).length > 80 || !Object.values(tokens).every((token) => bounded(token, 240, true))
    || !breakpoints || Object.keys(breakpoints).length > 12 || !Object.values(breakpoints).every((point) => integer(point, 240, 3840))
    || !bounded(item.iconStyle, 120, true) || !bounded(item.motionStyle, 120, true) || !bounded(item.globalCss, SOURCE_TEXT_CAP, true)) invalid();
  return item as unknown as StorefrontDesignPlan["designSystem"];
}

export function parseStorefrontDesignPlan(value: unknown): StorefrontDesignPlan {
  const item = record(value);
  const briefs = record(item?.routeBriefs);
  const briefKeys = ["shell", ...ROUTE_IDS];
  if (!item || !exact(item, ["concept", "designSystem", "routeBriefs"]) || !briefs || !exact(briefs, briefKeys)
    || !Object.values(briefs).every((brief) => bounded(brief, DESCRIPTION_CAP))) invalid();
  return { concept: parseConcept(item.concept), designSystem: parseDesignSystem(item.designSystem), routeBriefs: briefs as StorefrontDesignPlan["routeBriefs"] };
}

export function parseStructuralRouteResponse(value: unknown, routeId: StorefrontRouteId): StructuralRouteResponse {
  const item = record(value);
  if (!item || !exact(item, ["routeId", "route"]) || item.routeId !== routeId) invalid();
  return { routeId, route: routeId === "checkout" ? parseCheckout(item.route) : parseRoute(item.route) };
}

export function parseRedesignGroup(value: unknown, group: RedesignGroup["group"]): RedesignGroup {
  const item = record(value);
  const keys = group === "shell_home" ? ["group", "shell", "home"]
    : group === "catalog" ? ["group", "collection", "product", "search"]
      : ["group", "cart", "checkout"];
  if (!item || item.group !== group || !exact(item, keys)) invalid();
  if (group === "shell_home") return { group, shell: parseRoute(item.shell), home: parseRoute(item.home) };
  if (group === "catalog") return { group, collection: parseRoute(item.collection), product: parseRoute(item.product), search: parseRoute(item.search) };
  return { group, cart: parseRoute(item.cart), checkout: parseCheckout(item.checkout) };
}

export function parseRedesignRepairRequest(value: unknown): RedesignRepairRequest {
  const item = record(value);
  if (!item || !exact(item, ["routeId", "route", "diagnostics"]) || !ROUTE_IDS.includes(item.routeId as StorefrontRouteId)
    || !Array.isArray(item.diagnostics) || item.diagnostics.length === 0 || item.diagnostics.length > 20) invalid();
  const diagnostics = item.diagnostics.map((value) => {
    const diagnostic = record(value);
    if (!diagnostic || !exact(diagnostic, ["code", "message"], ["regionId"])
      || !bounded(diagnostic.code, 120) || !bounded(diagnostic.message, 1_000)
      || (diagnostic.regionId !== undefined && !bounded(diagnostic.regionId, 120))) invalid();
    return diagnostic as RedesignRepairRequest["diagnostics"][number];
  });
  const routeId = item.routeId as StorefrontRouteId;
  return { routeId, route: routeId === "checkout" ? parseCheckout(item.route) : parseRoute(item.route), diagnostics };
}

export function parseRedesignRepairResponse(value: unknown, routeId: StorefrontRouteId): RedesignRepairResponse {
  return parseStructuralRouteResponse(value, routeId);
}

export function parseRedesignProviderAudit(value: unknown): RedesignProviderAudit {
  const item = record(value);
  if (!item || !exact(item, ["provider", "model", "inputTokens", "outputTokens"])
    || item.provider !== "anthropic" || !bounded(item.model, 240)
    || !integer(item.inputTokens, 0, Number.MAX_SAFE_INTEGER) || !integer(item.outputTokens, 0, Number.MAX_SAFE_INTEGER)) invalid();
  return item as unknown as RedesignProviderAudit;
}

export function parseRedesignJson<T>(raw: string, parse: (value: unknown) => T): T {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > REDESIGN_OUTPUT_BYTE_CAP
    || Array.from(raw).length > REDESIGN_OUTPUT_CODE_POINT_CAP) invalid();
  try { return parse(JSON.parse(raw)); }
  catch { return invalid(); }
}
