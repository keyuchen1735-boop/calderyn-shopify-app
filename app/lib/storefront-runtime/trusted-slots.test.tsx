import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CheckoutLayoutManifest, TrustedSlotManifest } from "~/lib/storefront-bundle/types";
import { CheckoutIslands } from "./checkout-islands";
import { renderStorefrontRoute, type PublicPresentationData } from "./render.server";
import { TrustedSlotHost } from "./trusted-slots";

describe("platform-owned commerce hosts", () => {
  it("marks compiler-authorized commerce slots for closed-shadow mounting", () => {
    const slot: TrustedSlotManifest = {
      id: "cd-product-slot-1",
      kind: "addToCart",
      scopeId: "root",
      hostSize: "block",
      themeTokenIds: ["ink"],
    };
    const html = renderToStaticMarkup(<TrustedSlotHost slot={slot} instanceId={slot.id} authorityKey="product:p1" />);
    expect(html).toContain('data-cd-trusted-slot="addToCart"');
    expect(html).toContain('data-cd-shadow-mode="closed"');
    expect(html).toContain('data-cd-authority-key="product:p1"');
    expect(html).not.toContain("dangerouslySetInnerHTML");
  });

  it("issues unique repeated host IDs bound to each public record", () => {
    const data: PublicPresentationData = {
      store: { name: "Store", logo: null }, policyLinks: [], product: null, collection: null,
      featuredProducts: ["one", "two"].map((id) => ({
        id: `product-${id}`, handle: id, title: id, description: "", primaryImage: null, images: [], options: [],
        variants: [], price: null, compareAtPrice: null, availability: "Sold out" as const,
      })),
      relatedProducts: [], search: null, cart: null, notFound: null,
    };
    const result = renderStorefrontRoute({
      routeId: "home",
      nonce: "slot-nonce",
      data,
      artifact: {
        html: "", css: "", bindings: [], requiredData: [{ kind: "featuredProducts", limit: 2 }],
        requiredCapabilities: ["commerce"], interactions: { version: 1, state: [], bindings: [], transitions: [] },
        trustedSlots: [{
          id: "cd-home-slot-1", kind: "addToCart", scopeId: "products", hostSize: "block", themeTokenIds: [],
        }],
        tree: [{
          kind: "element", id: "cd-home-repeat", tag: "div", attributes: {},
          repeat: { scopeId: "products", source: "featured.products", itemKind: "product", keyPath: "product.id" },
          children: [{
            kind: "element", id: "cd-home-slot-1", tag: "div", attributes: {}, children: [],
            trustedSlotId: "cd-home-slot-1",
          }],
        }],
      },
    });
    const html = renderToStaticMarkup(result.element);
    const hostIds = html.match(/id="cd-home-slot-1-i-[A-Za-z0-9_-]+"/g) ?? [];
    expect(hostIds).toHaveLength(2);
    expect(new Set(hostIds).size).toBe(2);
    expect(html).toContain('data-cd-authority-key="product:product-one"');
    expect(html).toContain('data-cd-authority-key="product:product-two"');
  });

  it("renders checkout controls from a closed platform layout vocabulary", () => {
    const layout: CheckoutLayoutManifest = {
      columnMode: "summaryAside",
      sectionOrder: ["contact", "shipping", "payment", "summary"],
      spacingTokenId: "space-4",
      surfaceTokenIds: ["surface"],
    };
    const html = renderToStaticMarkup(<CheckoutIslands layout={layout} />);
    expect(html).toContain('data-cd-checkout-islands="summaryAside"');
    expect(html).toContain('data-cd-checkout-section="payment"');
  });
});
