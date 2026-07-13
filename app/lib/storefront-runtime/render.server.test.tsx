import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RouteArtifact, StorefrontBundleV1 } from "~/lib/storefront-bundle/types";
import { compileBundle } from "~/lib/storefront-compiler/compile";
import { VALID_BUNDLE_SOURCE } from "~/lib/storefront-compiler/__fixtures__/valid-bundle";
import {
  renderStorefrontSurface,
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
  it("renders shell and route artifacts from one immutable bundle with identical compiled keys", () => {
    const compiled = compileBundle(VALID_BUNDLE_SOURCE).bundle;
    const bundle: StorefrontBundleV1 = {
      ...compiled,
      shell: {
        ...compiled.shell,
        tree: [{
          kind: "element",
          id: "cd-shell-home-link",
          tag: "a",
          attributes: {},
          routeTarget: { routeId: "home", params: {} },
          children: [{ kind: "text", value: "Home" }],
        }, ...compiled.shell.tree],
      },
    };
    const publicHtml = renderToStaticMarkup(renderStorefrontSurface({
      bundle,
      routeId: "home",
      data,
      nonce: "same-request-nonce",
      mode: "public",
    }));
    const previewHtml = renderToStaticMarkup(renderStorefrontSurface({
      bundle,
      routeId: "home",
      data,
      nonce: "same-request-nonce",
      mode: "preview",
    }));

    expect(publicHtml).toContain('data-cd-bundle-shell="home"');
    expect(publicHtml).toContain('data-cd-bundle-route="home"');
    expect(publicHtml).toContain('nonce="same-request-nonce"');
    expect(previewHtml.match(/id="cd-[^"]+"/g)).toEqual(publicHtml.match(/id="cd-[^"]+"/g));
    expect(previewHtml).toContain("/dashboard/store/preview?route=home");
    expect(publicHtml).toContain('href="/storefront"');
  });

  it("composes deterministic collision-resistant instance IDs across nested repeats", () => {
    const repeatedArtifact = artifact({
      tree: [{
        kind: "element", id: "cd-home-outer", tag: "div", attributes: {},
        repeat: { scopeId: "cd-home-scope-outer", source: "featured.products", itemKind: "product", keyPath: "product.id" },
        children: [{
          kind: "element", id: "cd-home-inner", tag: "section", attributes: {},
          repeat: { scopeId: "cd-home-scope-inner", source: "featured.products", itemKind: "product", keyPath: "product.id" },
          children: [{ kind: "element", id: "cd-home-leaf", tag: "span", attributes: {}, children: [] }],
        }],
      }],
    });
    const repeatedData = {
      ...data,
      featuredProducts: [
        { ...publicProduct, id: "parent-a", handle: "parent-a" },
        { ...publicProduct, id: "parent-b", handle: "parent-b" },
      ],
    };
    const render = () => renderToStaticMarkup(createElement(() => renderStorefrontRoute({
      routeId: "home", artifact: repeatedArtifact, data: repeatedData, nonce: "route-nonce",
    }).element));
    const first = render();
    const second = render();
    const leafIds = [...first.matchAll(/id="(cd-home-leaf-[^"]+)"/g)].map((match) => match[1]);
    expect(leafIds).toHaveLength(4);
    expect(new Set(leafIds).size).toBe(4);
    expect(first).toBe(second);
  });

  it("does not collide repeat IDs that only differ after a long shared prefix", () => {
    const prefix = "x".repeat(80);
    const repeatedArtifact = artifact({
      tree: [{
        kind: "element", id: "cd-home-item", tag: "div", attributes: {}, children: [],
        repeat: { scopeId: "cd-home-scope-items", source: "featured.products", itemKind: "product", keyPath: "product.id" },
      }],
    });
    const result = renderStorefrontRoute({
      routeId: "home",
      artifact: repeatedArtifact,
      data: {
        ...data,
        featuredProducts: [
          { ...publicProduct, id: `${prefix}-a`, handle: "a" },
          { ...publicProduct, id: `${prefix}-b`, handle: "b" },
        ],
      },
      nonce: "route-nonce",
    });
    const html = renderToStaticMarkup(createElement(() => result.element));
    const ids = [...html.matchAll(/id="(cd-home-item-[^"]+)"/g)].map((match) => match[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

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

  it("refuses cart-line controls without the exact repeated cart-line scope", () => {
    const cartData: PublicPresentationData = {
      ...data,
      cart: {
        id: "cart-1", count: 1,
        lines: [{
          id: "line-1", title: "Line", quantity: 1,
          unitPrice: { cents: 1200, currency: "USD" }, total: { cents: 1200, currency: "USD" },
        }],
        subtotal: { cents: 1200, currency: "USD" }, discounts: { cents: 0, currency: "USD" },
        total: { cents: 1200, currency: "USD" },
      },
    };
    const invalid = artifact({
      tree: [{
        kind: "element", id: "cd-cart-slot-1", tag: "div", attributes: {}, children: [], trustedSlotId: "cd-cart-slot-1",
      }],
      trustedSlots: [{ id: "cd-cart-slot-1", kind: "cartLineControls", hostSize: "block", themeTokenIds: [] }],
    });
    expect(() => renderStorefrontRoute({ routeId: "cart", artifact: invalid, data: cartData, nonce: "route-nonce" }))
      .toThrow(/cartLine|authority/i);
  });

  it("renders checkout decoration and platform checkout controls as sibling roots", () => {
    const checkout: StorefrontBundleV1["routes"]["checkout"] = compileBundle(VALID_BUNDLE_SOURCE).bundle.routes.checkout;
    const html = renderToStaticMarkup(renderCheckoutRoute({ artifact: checkout, data, nonce: "checkout-nonce" }));
    expect(html).toMatch(/data-cd-checkout-decoration[\s\S]*<\/div><div data-cd-checkout-islands/);
    expect(html).toContain('data-cd-checkout-section="payment"');
    expect(html).toContain('<style nonce="checkout-nonce"');
  });
});
