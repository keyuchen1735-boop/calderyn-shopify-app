import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CheckoutLayoutManifest, TrustedSlotManifest } from "~/lib/storefront-bundle/types";
import { CheckoutIslands } from "./checkout-islands";
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
    const html = renderToStaticMarkup(<TrustedSlotHost slot={slot} />);
    expect(html).toContain('data-cd-trusted-slot="addToCart"');
    expect(html).toContain('data-cd-shadow-mode="closed"');
    expect(html).not.toContain("dangerouslySetInnerHTML");
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
