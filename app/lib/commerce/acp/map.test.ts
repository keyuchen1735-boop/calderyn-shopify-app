import { describe, it, expect } from "vitest";
import { toAcpFeedItem, toAcpSessionBody } from "./map";

describe("ACP mappers", () => {
  it("maps a catalog item to an ACP feed item", () => {
    const item = toAcpFeedItem({ variantId: "V1", title: "Widget", priceCents: 1999, currency: "usd", availableQty: 5, vendor: "Acme", category: "tools", tags: [] });
    expect(item).toMatchObject({ id: "V1", title: "Widget", availability: "in_stock" });
    expect(item.price).toBe("19.99 USD"); // ACP price string; confirm format against spec
  });
  it("maps a locked quote to an ACP session totals body in cents", () => {
    const body = toAcpSessionBody("sess_1", { quoteId: "q1", subtotalCents: 2000, shippingCents: 500, taxCents: 160, totalCents: 2660, currency: "usd", deliveryLatest: "2026-07-05", lines: [{ variantId: "V1", quantity: 2, unitPriceCents: 1000, currency: "usd", titleSnapshot: "Widget" }] } as never);
    expect(body.id).toBe("sess_1");
    expect(body.totals).toMatchObject({ total: 2660, tax: 160, shipping: 500, currency: "usd" });
  });
});
