import { isCompilerIdentifier } from "../storefront-compiler/assets";
import type { CheckoutRouteSource, RouteSource, StorefrontBundleSourceV1 } from "../storefront-compiler/compile";
import type {
  AssetRequest,
  ExploredConcept,
  MerchantStorefrontContext,
  RouteExpansion,
  StorefrontAiProvider,
  StructuredModelResponse,
} from "./contracts";
import { COMPILER_SYSTEM_PROMPT, EXPANSION_GROUP_SCHEMAS, expansionPrompt } from "./prompts";

type ExpansionGroup = "catalog" | "product" | "commerce";

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function route(value: unknown, field: string): RouteSource {
  const input = object(value, field);
  if (typeof input.html !== "string" || input.html.length > 250_000) throw new Error(`${field}.html is invalid`);
  if (typeof input.css !== "string" || input.css.length > 250_000) throw new Error(`${field}.css is invalid`);
  if (!Array.isArray(input.requiredData) || !Array.isArray(input.requiredCapabilities)) throw new Error(`${field} contracts are invalid`);
  return {
    html: input.html,
    css: input.css,
    requiredData: input.requiredData as RouteSource["requiredData"],
    requiredCapabilities: input.requiredCapabilities as RouteSource["requiredCapabilities"],
    ...(typeof input.rootScopeKind === "string" ? { rootScopeKind: input.rootScopeKind as RouteSource["rootScopeKind"] } : {}),
  };
}

function checkout(value: unknown): CheckoutRouteSource {
  const input = object(value, "checkout");
  if (typeof input.html !== "string" || input.html.length > 250_000 || typeof input.css !== "string" || input.css.length > 250_000) {
    throw new Error("checkout source is invalid");
  }
  return { html: input.html, css: input.css, layout: object(input.layout, "checkout.layout") as unknown as CheckoutRouteSource["layout"] };
}

function assetRequests(value: unknown): AssetRequest[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) throw new Error("Expansion asset requests are invalid");
  return value.map((entry) => {
    const item = object(entry, "asset request");
    if (typeof item.key !== "string" || !isCompilerIdentifier(item.key)) throw new Error("Expansion asset key is invalid");
    if (typeof item.purpose !== "string" || !item.purpose || item.purpose.length > 500 || typeof item.required !== "boolean") {
      throw new Error("Expansion asset request is invalid");
    }
    return {
      key: item.key,
      purpose: item.purpose,
      required: item.required,
      ...(typeof item.aspectRatio === "number" ? { aspectRatio: item.aspectRatio } : {}),
    };
  });
}

function parseGroup(group: ExpansionGroup, value: unknown): Partial<RouteExpansion> & { assetRequests: AssetRequest[] } {
  const input = object(value, `${group} expansion`);
  if (group === "catalog") return { collection: route(input.collection, "collection"), search: route(input.search, "search"), assetRequests: assetRequests(input.assetRequests) };
  if (group === "product") return { product: route(input.product, "product"), assetRequests: assetRequests(input.assetRequests) };
  return { cart: route(input.cart, "cart"), checkout: checkout(input.checkout), assetRequests: assetRequests(input.assetRequests) };
}

export interface ExpandWinnerInput {
  winner: ExploredConcept;
  context: MerchantStorefrontContext;
  provider: StorefrontAiProvider;
  signal?: AbortSignal;
  onModelCall?: (operation: "expand", response: StructuredModelResponse) => void;
}

export async function expandWinningConcept(input: ExpandWinnerInput): Promise<RouteExpansion> {
  const groups: readonly ExpansionGroup[] = ["catalog", "product", "commerce"];
  const outputs = await Promise.all(groups.map(async (group) => {
    const response = await input.provider.complete({
      operation: "expand",
      system: COMPILER_SYSTEM_PROMPT,
      prompt: expansionPrompt(input.winner, input.context, group),
      schema: EXPANSION_GROUP_SCHEMAS[group],
      signal: input.signal,
    });
    input.onModelCall?.("expand", response);
    return parseGroup(group, response.value);
  }));
  const catalog = outputs[0];
  const product = outputs[1];
  const commerce = outputs[2];
  if (!catalog.collection || !catalog.search || !product.product || !commerce.cart || !commerce.checkout) {
    throw new Error("Winner expansion did not return the complete route matrix");
  }
  const requests = new Map<string, AssetRequest>();
  for (const request of outputs.flatMap((output) => output.assetRequests)) {
    const existing = requests.get(request.key);
    if (existing && JSON.stringify(existing) !== JSON.stringify(request)) throw new Error(`Conflicting asset request ${request.key}`);
    requests.set(request.key, request);
  }
  return {
    collection: catalog.collection,
    search: catalog.search,
    product: product.product,
    cart: commerce.cart,
    checkout: commerce.checkout,
    assetRequests: [...requests.values()],
  };
}

export function expandedBundleSource(input: {
  generationId: string;
  promptHash: string;
  winner: ExploredConcept;
  expansion: RouteExpansion;
  assets: StorefrontBundleSourceV1["assets"];
}): StorefrontBundleSourceV1 {
  const signature = input.winner.candidate.concept.noveltySignature;
  return {
    source: { kind: "custom", generationId: input.generationId, promptHash: input.promptHash },
    concept: {
      name: input.winner.candidate.concept.name,
      rationale: input.winner.candidate.concept.rationale,
      noveltySignature: [signature.layoutTopology, signature.typeTreatment, signature.sectionSequence, signature.navigationModel, signature.interactionStyle],
    },
    designSystem: structuredClone(input.winner.candidate.designSystem),
    shell: structuredClone(input.winner.candidate.shell),
    routes: {
      home: structuredClone(input.winner.candidate.home),
      collection: structuredClone(input.expansion.collection),
      product: structuredClone(input.expansion.product),
      search: structuredClone(input.expansion.search),
      cart: structuredClone(input.expansion.cart),
      checkout: structuredClone(input.expansion.checkout),
    },
    assets: structuredClone(input.assets),
  };
}
