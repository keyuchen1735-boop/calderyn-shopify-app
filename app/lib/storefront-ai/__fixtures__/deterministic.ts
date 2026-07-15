import { VALID_BUNDLE_SOURCE } from "../../storefront-compiler/__fixtures__/valid-bundle";
import type { StorefrontBundleSourceV1 } from "../../storefront-compiler/compile";
import type {
  ConceptCandidateSource,
  MerchantStorefrontContext,
  NoveltySignature,
  RouteExpansion,
} from "../contracts";

export const TEST_SHOP_ID = "11111111-1111-4111-8111-111111111111";
export const TEST_VERSION_ID = "22222222-2222-4222-8222-222222222222";

export const DISTINCT_SIGNATURES: readonly NoveltySignature[] = [
  {
    layoutTopology: "orbiting product rail",
    typeTreatment: "oversized condensed labels",
    sectionSequence: "catalog first then story",
    navigationModel: "radial dock",
    interactionStyle: "direct manipulation",
  },
  {
    layoutTopology: "stacked specimen drawers",
    typeTreatment: "serif annotations",
    sectionSequence: "story then comparison",
    navigationModel: "chapter tabs",
    interactionStyle: "progressive disclosure",
  },
  {
    layoutTopology: "split horizon shelf",
    typeTreatment: "monospace price signals",
    sectionSequence: "utility then editorial",
    navigationModel: "edge index",
    interactionStyle: "snap and inspect",
  },
];

export function createContext(): MerchantStorefrontContext {
  return {
    version: 1,
    prompt: "Create an original product-first shop",
    promptHash: "sha256:test-prompt",
    referenceImages: [],
    store: { name: "Northline", logoAssetKey: null, publicBrandAssetKeys: [] },
    collections: [{ id: "c1", handle: "objects", title: "Objects", productCount: 2 }],
    products: [
      {
        id: "p1",
        handle: "lamp",
        title: "Arc Lamp",
        productType: "Lighting",
        tags: ["home"],
        optionNames: ["Finish"],
        priceMin: 12000,
        priceMax: 15000,
        currency: "USD",
        availability: "available",
        images: [{ assetKey: "catalog-lamp", aspectRatio: 1.25 }],
      },
    ],
    reusableAssets: [],
    recipeNoveltySignatures: [{ templateId: "atelier-nine", signature: DISTINCT_SIGNATURES[1] }],
    fingerprint: "sha256:test-context",
  };
}

export function createConcept(index = 0): ConceptCandidateSource {
  const base = structuredClone(VALID_BUNDLE_SOURCE);
  const signature = DISTINCT_SIGNATURES[index % DISTINCT_SIGNATURES.length];
  const topology = index % DISTINCT_SIGNATURES.length;
  base.routes.home.html = topology === 0
    ? `<main><h1 data-cd-text="store.name"></h1></main>`
    : topology === 1
      ? `<main><aside><p>Chapter index</p></aside><section><h1 data-cd-text="store.name"></h1></section></main>`
      : `<main><nav><p>Zone map</p></nav><article><header><h1 data-cd-text="store.name"></h1></header></article></main>`;
  base.designSystem.globalCss = "";
  return {
    candidateId: `concept-${index + 1}`,
    concept: {
      name: `Concept ${index + 1}`,
      rationale: "A product-forward original commerce system.",
      noveltySignature: signature,
    },
    designSystem: base.designSystem,
    shell: base.shell,
    home: base.routes.home,
    assetRequests: [],
  };
}

export function createExpansion(): RouteExpansion {
  const routes = structuredClone(VALID_BUNDLE_SOURCE.routes);
  return {
    collection: routes.collection,
    product: routes.product,
    search: routes.search,
    cart: routes.cart,
    checkout: routes.checkout,
  };
}

export function createFullSource(generationId = "gen-test"): StorefrontBundleSourceV1 {
  const source = structuredClone(VALID_BUNDLE_SOURCE);
  source.source = { kind: "custom", generationId, promptHash: "sha256:test-prompt" };
  return source;
}

export const PASSING_JUDGE_SCORES = {
  promptFit: 92,
  ecommerceClarity: 94,
  hierarchy: 90,
  responsiveQuality: 88,
  interactionClarity: 90,
  typographyImagery: 87,
  accessibility: 91,
  originality: 90,
};
