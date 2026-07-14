import { describe, expect, it } from "vitest";
import { compileBundle } from "../storefront-compiler/compile";
import { VALID_BUNDLE_SOURCE } from "../storefront-compiler/__fixtures__/valid-bundle";
import {
  STOREFRONT_PROOF_ROUTES,
  STOREFRONT_PROOF_VIEWPORTS,
  buildStorefrontProofCases,
  measureStorefrontBundle,
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
  });

  it("derives policy links from production-shaped merchant policy records", () => {
    const policies = storefrontProofPolicies();
    expect(policies).toHaveLength(4);
    expect(policies.every((policy) => policy.body.length > 40 && policy.updatedAt.length > 0)).toBe(true);
    expect(createStorefrontProofData("home").policyLinks).toEqual(storefrontPolicyLinks(policies));
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
});
