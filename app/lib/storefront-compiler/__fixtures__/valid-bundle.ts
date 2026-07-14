import type { StorefrontBundleSourceV1 } from "../compile";

export const VALID_BUNDLE_SOURCE: StorefrontBundleSourceV1 = {
  source: { kind: "custom", generationId: "gen-1", promptHash: "prompt" },
  concept: { name: "Example", rationale: "Clear", noveltySignature: ["grid"] },
  designSystem: {
    displayFontId: "fraunces",
    bodyFontId: "inter",
    tokens: { ink: "#111111" },
    breakpoints: { mobile: 390 },
    iconStyle: "line",
    motionStyle: "restrained",
    globalCss: `.shell { color: var(--ink) }`,
  },
  shell: {
    html: `<header data-cd-text="store.name"></header>`,
    css: `.shell { display:grid }`,
    requiredData: [],
    requiredCapabilities: [],
  },
  routes: {
    home: {
      html: `<main><h1 data-cd-text="store.name"></h1></main>`,
      css: `main { display:block }`,
      requiredData: [],
      requiredCapabilities: [],
    },
    collection: {
      html: `<main data-cd-repeat="collection.products"><article data-cd-key="product.id" data-cd-text="product.title"></article></main>`,
      css: `main { display:grid }`,
      requiredData: [],
      requiredCapabilities: [],
    },
    product: {
      html: `<main class="product"><h1 data-cd-text="product.title"></h1><div id="buy" class="model-slot" title="hide me" data-cd-slot="addToCart" data-cd-host-size="block"></div></main>`,
      css: `.product > h1 { display:block }`,
      requiredData: [],
      requiredCapabilities: [],
      rootScopeKind: "product",
    },
    search: {
      html: `<main><h1>Search</h1></main>`,
      css: `main { display:block }`,
      requiredData: [],
      requiredCapabilities: [],
    },
    cart: {
      html: `<main><div id="summary" data-cd-slot="cartSummary" data-cd-host-size="page"></div></main>`,
      css: ``,
      requiredData: [],
      requiredCapabilities: [],
    },
    checkout: {
      html: `<header data-cd-text="store.name"></header>`,
      css: `header { display:block; color: var(--ink) }`,
      layout: {
        columnMode: "summaryAside",
        sectionOrder: ["contact", "shipping", "delivery", "consent", "payment", "summary"],
        spacingTokenId: "space-4",
        surfaceTokenIds: ["surface"],
      },
    },
  },
  assets: { entries: [] },
};
