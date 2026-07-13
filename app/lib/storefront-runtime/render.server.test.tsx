import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RouteArtifact, StorefrontBundleV1 } from "~/lib/storefront-bundle/types";
import { compileBundle } from "~/lib/storefront-compiler/compile";
import { VALID_BUNDLE_SOURCE } from "~/lib/storefront-compiler/__fixtures__/valid-bundle";
import {
  renderCheckoutRoute,
  renderStorefrontRoute,
  type PublicPresentationData,
} from "./render.server";

const emptyInteractions = { version: 1 as const, state: [], bindings: [], transitions: [] };
const publicProduct: NonNullable<PublicPresentationData["product"]> = {
  id: "product-1",
  handle: "product-one",
  title: "Product one",
  description: "",
  primaryImage: null,
  images: [],
  options: [],
  variants: [{
    id: "variant-1",
    title: "Default",
    price: { cents: 1200, currency: "USD" },
    compareAtPrice: null,
    availability: "In stock",
    available: true,
  }],
  price: { cents: 1200, currency: "USD" },
  compareAtPrice: null,
  availability: "In stock",
};
const data: PublicPresentationData = {
  store: { name: `</h1><script>alert("x")</script>`, logo: null },
  policyLinks: [],
  product: null,
  collection: null,
  featuredProducts: [],
  relatedProducts: [],
  search: null,
  cart: null,
  notFound: null,
};

function artifact(overrides: Partial<RouteArtifact> = {}): RouteArtifact {
  return {
    html: `<script>whole-route source must never render</script>`,
    tree: [{
      kind: "element",
      id: "cd-home-title",
      tag: "h1",
      attributes: { title: `Pinned "attribute"` },
      children: [{ kind: "text", value: "fallback" }],
    }],
    bindings: [{
      id: "binding-title",
      targetId: "cd-home-title",
      kind: "text",
      ref: { kind: "data", scopeId: "root", path: "store.name" },
    }],
    css: "",
    requiredData: [{ kind: "storeIdentity" }],
    requiredCapabilities: [],
    interactions: emptyInteractions,
    trustedSlots: [],
    ...overrides,
  };
}

describe("compiled-node server renderer", () => {
  it("renders authoritative CompiledNode trees with React-escaped text and attributes", () => {
    const result = renderStorefrontRoute({ routeId: "home", artifact: artifact({ css: ".title{color:red}" }), data, nonce: "route-nonce" });
    const html = renderToStaticMarkup(createElement(() => result.element));
    expect(result.status).toBe(200);
    expect(html).toContain("&lt;/h1&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).toContain('title="Pinned &quot;attribute&quot;"');
    expect(html).not.toContain("whole-route source must never render");
    expect(html).not.toContain("dangerouslySetInnerHTML");
    expect(html).toContain('<style nonce="route-nonce"');
    expect(html).toContain(".title{color:red}");
  });

  it("returns a platform-owned 404 instead of rendering a generated missing-record route", () => {
    const result = renderStorefrontRoute({
      routeId: "product",
      artifact: artifact(),
      data: { ...data, notFound: { kind: "product", handle: "gone" } },
      nonce: "route-nonce",
    });
    expect(result.status).toBe(404);
    const html = renderToStaticMarkup(createElement(() => result.element));
    expect(html).toContain("Product not found");
    expect(html).not.toContain("whole-route source must never render");
  });

  it("replaces compiler-authorized slot nodes with platform-owned closed-shadow hosts", () => {
    const bundle = compileBundle(VALID_BUNDLE_SOURCE).bundle;
    const result = renderStorefrontRoute({
      routeId: "product",
      artifact: bundle.routes.product,
      data: { ...data, product: publicProduct },
      nonce: "route-nonce",
    });
    const html = renderToStaticMarkup(createElement(() => result.element));
    expect(html).toContain('data-cd-trusted-slot="addToCart"');
    expect(html).toContain('data-cd-shadow-mode="closed"');
    expect(html).toContain('data-cd-authority-key="product:product-1"');
    expect(html).not.toContain("hide me");
  });

  it("renders checkout decoration and platform checkout controls as sibling roots", () => {
    const checkout: StorefrontBundleV1["routes"]["checkout"] = compileBundle(VALID_BUNDLE_SOURCE).bundle.routes.checkout;
    const html = renderToStaticMarkup(renderCheckoutRoute({ artifact: checkout, data, nonce: "checkout-nonce" }));
    expect(html).toMatch(/data-cd-checkout-decoration[\s\S]*<\/div><div data-cd-checkout-islands/);
    expect(html).toContain('data-cd-checkout-section="payment"');
    expect(html).toContain('<style nonce="checkout-nonce"');
  });
});
