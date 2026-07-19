import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compileBundle } from "../storefront-compiler/compile";
import { VALID_BUNDLE_SOURCE } from "../storefront-compiler/__fixtures__/valid-bundle";
import {
  STOREFRONT_PROOF_ROUTES,
  isSupportedStorefrontProofLink,
  STOREFRONT_PROOF_VIEWPORTS,
  type StorefrontProofExpectations,
  buildStorefrontProofCases,
  createStorefrontProofCatalog,
  createStorefrontProofDataForBundle,
  createStorefrontProofDataForContext,
  detectBuyerFlowFailures,
  detectCatalogPaginationFailure,
  detectFullStoryFailures,
  detectHorizontalLayoutFailures,
  measureStorefrontBundle,
  proveStorefrontBundle,
  shouldVerifyStorefrontPreview,
  shouldWriteStorefrontPreview,
  validateStorefrontBundleBudgets,
} from "./browser.server";
import { createStorefrontProofData, storefrontProofContext, storefrontProofPolicies } from "./fixtures";
import { storefrontPolicyLinks } from "../storefront/policies.server";
import { shaderSourceWithinCap } from "../storebuilder/fx/shader";
import { STOREFRONT_RECIPES } from "../storefront-recipes";
import { INVALID_SHADER_PROOF_SOURCE } from "./verify.server";
import { getStoreTemplate } from "../storefront-bundle/registry";

describe("storefront browser proof matrix", () => {
  it("embeds Axe in the server bundle instead of resolving it from node_modules at runtime", () => {
    const source = readFileSync(
      resolve(process.cwd(), "app/lib/storefront-validation/browser.server.ts"),
      "utf8",
    );

    expect(source).toContain('from "axe-core/axe.min.js?raw"');
    expect(source).not.toContain('require.resolve("axe-core/axe.min.js")');
  });

  it("covers every route at the three validation-profile viewports", () => {
    const cases = buildStorefrontProofCases(compileBundle(VALID_BUNDLE_SOURCE).bundle);

    expect(STOREFRONT_PROOF_VIEWPORTS).toEqual([
      { name: "mobile", width: 390, height: 844 },
      { name: "tablet", width: 768, height: 1024 },
      { name: "desktop", width: 1440, height: 1000 },
    ]);
    expect(STOREFRONT_PROOF_ROUTES).toEqual(["home", "collection", "product", "search", "cart", "checkout"]);
    expect(cases).toHaveLength(18);
    expect(new Set(cases.map((entry) => entry.routeId))).toEqual(new Set(STOREFRONT_PROOF_ROUTES));
  });

  it("expands collection and search into bounded 61-product cursor pages", () => {
    const cases = buildStorefrontProofCases(
      compileBundle(VALID_BUNDLE_SOURCE).bundle,
      ["collection", "search"],
      { catalogProductCount: 61, viewports: ["mobile", "desktop"] },
    );

    expect(cases).toHaveLength(12);
    for (const routeId of ["collection", "search"] as const) {
      const routeCases = cases.filter((entry) => entry.routeId === routeId);
      expect(routeCases.map(({ catalogOffset }) => catalogOffset)).toEqual([0, 0, 24, 24, 48, 48]);
      expect(routeCases.map(({ viewport }) => viewport.name)).toEqual([
        "mobile", "desktop", "mobile", "desktop", "mobile", "desktop",
      ]);
    }
  });

  it("builds realistic sale, sold-out, long-copy, missing-image, empty, and checkout fixtures", () => {
    const product = createStorefrontProofData("product");
    const collection = createStorefrontProofData("collection");
    const search = createStorefrontProofData("search");
    const checkout = createStorefrontProofData("checkout");
    const storyContext = storefrontProofContext();
    const storyProduct = createStorefrontProofDataForContext("product", storyContext).product;

    expect(product.product?.description.length).toBeGreaterThan(500);
    expect(product.product?.variants.some((variant) => !variant.available)).toBe(true);
    expect(product.product?.compareAtPrice?.cents).toBeGreaterThan(product.product?.price?.cents ?? 0);
    expect(product.relatedProducts.some((entry) => entry.primaryImage === null)).toBe(true);
    expect(collection.collection?.products.length).toBeGreaterThan(2);
    expect(search.search?.results).toHaveLength(0);
    expect(checkout.cart?.lines.length).toBeGreaterThan(0);
    expect(storyContext.products).toHaveLength(61);
    expect(storyContext.products.filter((entry) => entry.images.length === 0)).toHaveLength(10);
    expect(storyContext.collections.length).toBeGreaterThan(1);
    for (const collection of storyContext.collections) {
      expect(storyContext.products.filter(({ collectionIds }) => collectionIds?.includes(collection.id) ?? false)).toHaveLength(collection.productCount);
    }
    expect(new Set(storyContext.products.map(({ availability }) => availability))).toEqual(new Set(["available", "sold_out", "mixed"]));
    expect(storyProduct?.description.length).toBeGreaterThan(500);
    expect(storyProduct?.variants.length).toBeGreaterThan(1);
    expect(storyProduct?.variants.some(({ available }) => !available)).toBe(true);
    expect(storefrontProofContext(27).products).toHaveLength(27);
  });

  it("carries a normal ready asset URL through the production catalog interface", async () => {
    const context = storefrontProofContext(1);
    const readyUrl = "https://assets.example.test/shop-assets/proof/generated-product.webp";
    context.products[0]!.images = [];
    const catalog = createStorefrontProofCatalog(context, [{
      productId: context.products[0]!.id,
      url: readyUrl,
    }]);

    expect((await catalog.getProduct("proof-shop", context.products[0]!.handle))?.images[0]?.url).toBe(readyUrl);
  });

  it("fails when an expected generated image never becomes browser-visible", async () => {
    const expectations: StorefrontProofExpectations = {
      generatedImageUrls: ["https://storefront-proof.local/__proof__/generated/missing.svg"],
    };

    const result = await proveStorefrontBundle({
      bundle: compileBundle(VALID_BUNDLE_SOURCE).bundle,
      context: storefrontProofContext(1),
      routes: ["product"],
      viewports: ["mobile"],
      expectations,
    });

    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "story.generated-images",
      detail: { expected: 1, visible: 0 },
    }));
  }, 60_000);

  it("loads a normal owned generated URL through the production catalog proof", async () => {
    const context = storefrontProofContext(1);
    context.products[0]!.images = [];
    const readyUrl = "https://assets.example.test/shop-assets/proof/generated-product.webp";
    const catalog = createStorefrontProofCatalog(context, [{
      productId: context.products[0]!.id,
      url: readyUrl,
    }]);

    const result = await proveStorefrontBundle({
      bundle: STOREFRONT_RECIPES[0].bundle,
      context,
      catalog,
      catalogPagination: true,
      routes: ["collection"],
      viewports: ["mobile"],
      expectations: { generatedImageUrls: [readyUrl] },
    });

    expect(result.diagnostics.filter(({ code }) =>
      code === "story.generated-images" || code === "network.unexpected" || code === "asset.failed")).toEqual([]);
  }, 60_000);

  it("proves a historical derived recipe with its immutable content-addressed hero", async () => {
    const bundle = structuredClone(STOREFRONT_RECIPES[0].bundle);
    const version = getStoreTemplate("custom-bench").versions[1]!;
    bundle.source = {
      kind: "custom",
      generationId: "historical-derived-proof",
      promptHash: "sha256:historical-derived-proof",
      derivedFromTemplateId: "custom-bench",
      derivedFromTemplateVersion: version.templateVersion,
    };
    bundle.assets = structuredClone(version.assets);

    const result = await proveStorefrontBundle({
      bundle,
      routes: ["home"],
      viewports: ["mobile"],
    });

    expect(result.diagnostics.filter(({ code }) =>
      code === "asset.persisted-missing" || code === "network.unexpected" || code === "asset.failed")).toEqual([]);
  }, 60_000);

  it("requires the complete PDP description and the expected visual-layer outcome", () => {
    expect(detectFullStoryFailures({
      routeId: "product",
      expectedProductDescription: "Complete merchant description",
      renderedText: "Complete merchant",
      hasVisualCanvas: true,
      hasProtectedFallback: false,
      visualExpectation: null,
    })).toEqual(["product-description-incomplete"]);
    expect(detectFullStoryFailures({
      routeId: "home",
      expectedProductDescription: null,
      renderedText: "",
      hasVisualCanvas: false,
      hasProtectedFallback: true,
      visualExpectation: "canvas",
    })).toEqual(["visual-canvas-missing", "protected-fallback-visible"]);
    expect(detectFullStoryFailures({
      routeId: "home",
      expectedProductDescription: null,
      renderedText: "",
      hasVisualCanvas: true,
      hasProtectedFallback: false,
      visualExpectation: "fallback",
    })).toEqual(["visual-canvas-unexpected", "protected-fallback-missing"]);
    expect(detectFullStoryFailures({
      routeId: "home",
      expectedProductDescription: null,
      renderedText: "",
      hasVisualCanvas: false,
      hasProtectedFallback: true,
      visualExpectation: "fallback",
    })).toEqual([]);
  });

  it("keeps the invalid-shader browser proof syntactically broken but inside the source cap", () => {
    expect(INVALID_SHADER_PROOF_SOURCE).toBe("void main() {");
    expect(shaderSourceWithinCap(INVALID_SHADER_PROOF_SOURCE)).toBe(true);
  });

  it("fails explicit home text, product-order, and visual expectations", () => {
    expect(detectFullStoryFailures({
      routeId: "home",
      expectedProductDescription: null,
      expectedHeroText: "Fidelity proof atelier-nine",
      expectedFeaturedProductIds: ["product-b", "product-a"],
      renderedText: "Fidelity proof atelier",
      renderedFeaturedProductIds: ["product-a", "product-b"],
      hasVisualCanvas: false,
      hasProtectedFallback: true,
      visualExpectation: "canvas",
    })).toEqual([
      "hero-text-missing",
      "featured-products-order-mismatch",
      "visual-canvas-missing",
      "protected-fallback-visible",
    ]);
  });

  it("does not satisfy an explicit hero expectation with a hidden h1", async () => {
    const bundle = compileBundle(structuredClone(VALID_BUNDLE_SOURCE)).bundle;
    bundle.routes.home.css += " h1 { display:none!important }";

    const result = await proveStorefrontBundle({
      bundle,
      routes: ["home"],
      viewports: ["mobile"],
      expectations: { home: { heroText: "Northline Supply & Studio" } },
    });

    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "story.incomplete",
      detail: expect.objectContaining({ failures: expect.arrayContaining(["hero-text-missing"]) }),
    }));
  }, 60_000);

  it("builds and aggregates the 61-product collection and search cursor pages", () => {
    const context = storefrontProofContext();
    const pageOffsets = [0, 24, 48];

    for (const routeId of ["collection", "search"] as const) {
      const pages = pageOffsets.map((offset) => createStorefrontProofDataForContext(
        routeId,
        context,
        undefined,
        12,
        offset,
      ));
      const ids = pages.flatMap((page) => routeId === "collection"
        ? page.collection?.products.map(({ id }) => id) ?? []
        : page.search?.results.map(({ id }) => id) ?? []);

      expect(pages.map((page) => routeId === "collection"
        ? page.collection?.products.length
        : page.search?.results.length)).toEqual([24, 24, 13]);
      expect(ids).toHaveLength(61);
      expect(new Set(ids).size).toBe(61);
    }
  });

  it("fails catalog pagination when browser-observed identities are missing or duplicated", () => {
    const ids = storefrontProofContext().products.map(({ id }) => id);
    const pages = [ids.slice(0, 24), ids.slice(24, 48), ids.slice(48)];

    expect(detectCatalogPaginationFailure(ids, pages)).toBeNull();
    expect(detectCatalogPaginationFailure(ids, [pages[0]!.slice(1), pages[1]!, pages[2]!]))
      .toMatchObject({ code: "catalog.pagination", detail: { total: 60, unique: 60 } });
    expect(detectCatalogPaginationFailure(ids, [[...pages[0]!, ids[0]!], pages[1]!, pages[2]!]))
      .toMatchObject({ code: "catalog.pagination", detail: { total: 62, unique: 61 } });
  });

  it("requires cart mutation state and checkout navigation instead of control clicks alone", () => {
    const requests = [
      { url: "/storefront/api/cart/quantity", method: "POST", body: { lineId: "line-1", quantity: 3 } },
      { url: "/storefront/api/cart/remove", method: "POST", body: { lineId: "line-1" } },
    ];

    expect(detectBuyerFlowFailures({
      routeId: "cart",
      requests,
      navigation: null,
      refreshCount: 2,
      initialCartCount: 2,
      finalCartCount: 0,
      expectedCartLine: { id: "line-1", quantity: 2 },
    })).toContain("checkout-navigation-missing");
    expect(detectBuyerFlowFailures({
      routeId: "cart",
      requests,
      navigation: "/storefront/checkout",
      refreshCount: 2,
      initialCartCount: 2,
      finalCartCount: 0,
      expectedCartLine: { id: "line-1", quantity: 2 },
    })).toEqual([]);
  });

  it("requires an exact add-to-cart payload and an exercised checkout submission", () => {
    expect(detectBuyerFlowFailures({
      routeId: "product",
      requests: [],
      navigation: null,
      refreshCount: 0,
      initialCartCount: 2,
      finalCartCount: 2,
      expectedVariantId: "variant-1",
    })).toEqual(expect.arrayContaining(["cart-add-request-missing", "cart-state-unchanged"]));
    expect(detectBuyerFlowFailures({
      routeId: "checkout",
      requests: [{
        url: "/storefront/checkout",
        method: "POST",
        body: { intent: "quote", email: "buyer@example.test" },
      }],
      navigation: null,
      refreshCount: 1,
      initialCartCount: 2,
      finalCartCount: 2,
    })).toEqual([]);
  });

  it("executes product, cart, and checkout buyer actions in Chromium", async () => {
    const result = await proveStorefrontBundle({
      bundle: STOREFRONT_RECIPES[0].bundle,
      routes: ["product", "cart", "checkout"],
      viewports: ["mobile"],
    });

    expect(result.cases).toBe(3);
    expect(result.diagnostics.filter(({ code }) => code === "buyer.path")).toEqual([]);
  }, 60_000);

  it("detects cursor duplication after rendering production public-data pages", async () => {
    const context = storefrontProofContext();
    const healthy = createStorefrontProofCatalog(context);
    const catalog = {
      ...healthy,
      async searchProductPage(...args: Parameters<typeof healthy.searchProductPage>) {
        const page = await healthy.searchProductPage(...args);
        if (args[1].after && page.items.length > 2) {
          page.items[1] = page.items[0]!;
        }
        return page;
      },
    };

    const result = await proveStorefrontBundle({
      bundle: compileBundle(VALID_BUNDLE_SOURCE).bundle,
      context,
      catalog,
      catalogPagination: true,
      routes: ["collection", "search"],
      viewports: ["mobile"],
    });

    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ routeId: "collection", code: "catalog.pagination" }),
      expect.objectContaining({ routeId: "search", code: "catalog.pagination" }),
    ]));
  }, 60_000);

  it("preserves a genuinely empty catalog instead of silently substituting demo products", () => {
    const empty = storefrontProofContext(0);
    const home = createStorefrontProofDataForContext("home", empty);
    const collection = createStorefrontProofDataForContext("collection", empty);
    const product = createStorefrontProofDataForContext("product", empty);

    expect(home.featuredProducts).toEqual([]);
    expect(home.relatedProducts).toEqual([]);
    expect(collection.collection).toMatchObject({ productCount: 0, products: [] });
    expect(product.product).toBeNull();
  });

  it("selects home proof products by the immutable featured-product order", () => {
    const catalog = storefrontProofContext(3);
    const selected = [catalog.products[2]!.id, catalog.products[0]!.id];

    const home = createStorefrontProofDataForContext("home", catalog, selected, 1);
    const collection = createStorefrontProofDataForContext("collection", catalog, selected);

    expect(home.featuredProducts.map(({ id }) => id)).toEqual(selected.slice(0, 1));
    expect(collection.featuredProducts.map(({ id }) => id)).toEqual(catalog.products.map(({ id }) => id));
  });

  it("wires immutable bundle featured products into browser-proof data", () => {
    const catalog = storefrontProofContext(3);
    const bundle = compileBundle(structuredClone(VALID_BUNDLE_SOURCE)).bundle;
    bundle.featuredProductIds = [catalog.products[2]!.id, catalog.products[0]!.id];
    bundle.routes.home.requiredData = [{ kind: "featuredProducts", limit: 1 }];

    const home = createStorefrontProofDataForBundle("home", bundle, catalog);

    expect(home.featuredProducts.map(({ id }) => id)).toEqual([catalog.products[2]!.id]);
  });

  it("writes generated preview assets only during an intentional baseline refresh", () => {
    expect(shouldVerifyStorefrontPreview("home", "desktop", {
      previewFile: "preview.webp",
      updateBaselines: false,
    })).toBe(true);
    expect(shouldVerifyStorefrontPreview("collection", "desktop", {
      previewFile: "preview.webp",
      updateBaselines: false,
    })).toBe(false);
    expect(shouldWriteStorefrontPreview("home", "desktop", {
      previewFile: "preview.webp",
      updateBaselines: false,
    })).toBe(false);
    expect(shouldWriteStorefrontPreview("home", "desktop", {
      previewFile: "preview.webp",
      updateBaselines: true,
    })).toBe(true);
    expect(shouldWriteStorefrontPreview("collection", "desktop", {
      previewFile: "preview.webp",
      updateBaselines: true,
    })).toBe(false);
  });

  it("derives policy links from production-shaped merchant policy records", () => {
    const policies = storefrontProofPolicies();
    expect(policies).toHaveLength(4);
    expect(policies.every((policy) => policy.body.length > 40 && policy.updatedAt.length > 0)).toBe(true);
    expect(createStorefrontProofData("home").policyLinks).toEqual(storefrontPolicyLinks(policies));
  });

  it("treats exact storefront policy URLs as supported internal routes", () => {
    expect(isSupportedStorefrontProofLink("/storefront/policies/shipping")).toBe(true);
    expect(isSupportedStorefrontProofLink("/storefront/policies/refund?from=checkout")).toBe(true);
    expect(isSupportedStorefrontProofLink("/storefront/policies/invented")).toBe(false);
    expect(isSupportedStorefrontProofLink("/admin/policies/shipping")).toBe(false);
  });

  it("fails closed when DOM, CSS, interaction, route, or full-bundle budgets are exceeded", () => {
    const compiled = structuredClone(compileBundle(VALID_BUNDLE_SOURCE).bundle);
    compiled.routes.home.css += "x".repeat(260_000);
    const metrics = measureStorefrontBundle(compiled);
    const report = validateStorefrontBundleBudgets(compiled);

    expect(metrics.fullBundleBytes).toBeGreaterThan(0);
    expect(report.ok).toBe(false);
    expect(report.diagnostics.some((entry) => entry.code === "budget.route-bytes" || entry.code === "budget.bundle-bytes")).toBe(true);
  });

  it("rejects the reported 2688px viewport escape while allowing intentional clipped compositions", () => {
    expect(detectHorizontalLayoutFailures({
      documentWidth: 2_688,
      viewportWidth: 1_920,
      candidates: [{ label: "northbound-hero", left: 821, right: 2_688, contained: false }],
    })).toEqual([
      "document:2688px>1920px",
      "northbound-hero:821..2688px",
    ]);

    expect(detectHorizontalLayoutFailures({
      documentWidth: 1_920,
      viewportWidth: 1_920,
      candidates: [{ label: "cropped-art", left: 821, right: 2_688, contained: true }],
    })).toEqual([]);
  });
});
