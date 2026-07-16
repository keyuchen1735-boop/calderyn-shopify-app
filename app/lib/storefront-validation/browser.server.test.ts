import { describe, expect, it } from "vitest";
import { compileBundle } from "../storefront-compiler/compile";
import { VALID_BUNDLE_SOURCE } from "../storefront-compiler/__fixtures__/valid-bundle";
import {
  STOREFRONT_PROOF_ROUTES,
  isSupportedStorefrontProofLink,
  STOREFRONT_PROOF_VIEWPORTS,
  buildStorefrontProofCases,
  createStorefrontProofDataForContext,
  detectHorizontalLayoutFailures,
  measureStorefrontBundle,
  shouldWriteStorefrontPreview,
  validateStorefrontBundleBudgets,
} from "./browser.server";
import { createStorefrontProofData, storefrontProofContext, storefrontProofPolicies } from "./fixtures";
import { storefrontPolicyLinks } from "../storefront/policies.server";

describe("storefront browser proof matrix", () => {
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

  it("builds realistic sale, sold-out, long-copy, missing-image, empty, and checkout fixtures", () => {
    const product = createStorefrontProofData("product");
    const collection = createStorefrontProofData("collection");
    const search = createStorefrontProofData("search");
    const checkout = createStorefrontProofData("checkout");

    expect(product.product?.description.length).toBeGreaterThan(500);
    expect(product.product?.variants.some((variant) => !variant.available)).toBe(true);
    expect(product.product?.compareAtPrice?.cents).toBeGreaterThan(product.product?.price?.cents ?? 0);
    expect(product.relatedProducts.some((entry) => entry.primaryImage === null)).toBe(true);
    expect(collection.collection?.products.length).toBeGreaterThan(2);
    expect(search.search?.results).toHaveLength(0);
    expect(checkout.cart?.lines.length).toBeGreaterThan(0);
    expect(storefrontProofContext().products.length).toBeGreaterThan(1);
    expect(storefrontProofContext(27).products).toHaveLength(27);
  });

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

  it("writes generated preview assets only during an intentional baseline refresh", () => {
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
