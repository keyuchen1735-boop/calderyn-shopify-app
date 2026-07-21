import { describe, expect, it } from "vitest";
import {
  commitPreviewCommerceSession,
  createPreviewCommerceAdapter,
  readPreviewCommerceSession,
} from "./preview-commerce.server";

describe("preview commerce adapter", () => {
  it("persists a shop-scoped simulated cart without writing the buyer cart cookie", async () => {
    const request = new Request("https://app.example.com/dashboard/store/preview?route=product&handle=tee");
    const initial = await readPreviewCommerceSession(request, "shop-1");
    const adapter = createPreviewCommerceAdapter(initial);

    adapter.add({
      lineId: "preview-line-1",
      variantId: "variant-1",
      title: "Tee",
      quantity: 2,
      unitPrice: { cents: 2500, currency: "USD" },
    });

    const cookie = await commitPreviewCommerceSession(adapter.snapshot());
    expect(cookie).toContain("cd_storefront_preview=");
    expect(cookie).not.toContain("cd_cart=");

    const next = new Request("https://app.example.com/dashboard/store/preview?route=cart", {
      headers: { cookie: cookie.split(";", 1)[0] },
    });
    await expect(readPreviewCommerceSession(next, "shop-1")).resolves.toMatchObject({
      shopId: "shop-1",
      cart: { count: 2, subtotal: { cents: 5000, currency: "USD" } },
    });
  });

  it("simulates checkout without exposing an order, inventory, or payment capability", async () => {
    const adapter = createPreviewCommerceAdapter({ shopId: "shop-1", lines: [] });
    expect(adapter.checkout()).toEqual({ kind: "simulated", status: "ready" });
    expect(adapter).not.toHaveProperty("createOrder");
    expect(adapter).not.toHaveProperty("reserveInventory");
    expect(adapter).not.toHaveProperty("createPaymentIntent");
  });

  it("adds a validated bundle atomically and canonicalizes repeated variants", () => {
    const adapter = createPreviewCommerceAdapter({ shopId: "shop-1", lines: [] });
    adapter.addBundle([
      { lineId: "preview:v1", variantId: "v1", title: "Lemon", quantity: 1, unitPrice: { cents: 300, currency: "USD" } },
      { lineId: "preview:v1", variantId: "v1", title: "Lemon", quantity: 1, unitPrice: { cents: 300, currency: "USD" } },
      { lineId: "preview:v2", variantId: "v2", title: "Ginger", quantity: 1, unitPrice: { cents: 400, currency: "USD" } },
    ]);

    expect(adapter.cart()).toMatchObject({
      count: 3,
      subtotal: { cents: 1000, currency: "USD" },
      lines: [{ id: "preview:v1", quantity: 2 }, { id: "preview:v2", quantity: 1 }],
    });
  });

  it("preserves the stored price when a bundle repeats an existing variant", () => {
    const adapter = createPreviewCommerceAdapter({
      shopId: "shop-1",
      lines: [{
        lineId: "preview:v1", variantId: "v1", title: "Stored lemon", quantity: 1,
        unitPrice: { cents: 100, currency: "USD" },
      }],
    });

    adapter.addBundle([
      { lineId: "preview:v1", variantId: "v1", title: "Current lemon", quantity: 1, unitPrice: { cents: 200, currency: "USD" } },
      { lineId: "preview:v2", variantId: "v2", title: "Ginger", quantity: 1, unitPrice: { cents: 200, currency: "USD" } },
    ]);

    expect(adapter.cart()).toMatchObject({
      count: 3,
      subtotal: { cents: 400, currency: "USD" },
      lines: [
        { id: "preview:v1", title: "Stored lemon", quantity: 2, unitPrice: { cents: 100, currency: "USD" } },
        { id: "preview:v2", quantity: 1, unitPrice: { cents: 200, currency: "USD" } },
      ],
    });
  });

  it("leaves the preview cart unchanged when any bundle line is invalid", () => {
    const adapter = createPreviewCommerceAdapter({ shopId: "shop-1", lines: [] });
    expect(() => adapter.addBundle([
      { lineId: "preview:v1", variantId: "v1", title: "Lemon", quantity: 1, unitPrice: { cents: 300, currency: "USD" } },
      { lineId: "preview:v2", variantId: "v2", title: "Ginger", quantity: 2, unitPrice: { cents: 400, currency: "USD" } },
    ])).toThrow("Invalid preview bundle line");
    expect(adapter.cart()).toMatchObject({ count: 0, lines: [] });
  });

  it("matches the public cart quantity ceiling after repeated bundle selections", () => {
    const line = { lineId: "preview:v1", variantId: "v1", title: "Lemon", quantity: 997, unitPrice: { cents: 300, currency: "USD" } };
    const adapter = createPreviewCommerceAdapter({ shopId: "shop-1", lines: [line] });
    adapter.addBundle([{ ...line, quantity: 1 }, { ...line, quantity: 1 }]);
    expect(adapter.cart()).toMatchObject({ count: 999, lines: [{ quantity: 999 }] });
  });

  it("keeps the prior quantity when a repeated bundle would exceed 999", () => {
    const line = { lineId: "preview:v1", variantId: "v1", title: "Lemon", quantity: 998, unitPrice: { cents: 300, currency: "USD" } };
    const adapter = createPreviewCommerceAdapter({ shopId: "shop-1", lines: [line] });
    expect(() => adapter.addBundle([{ ...line, quantity: 1 }, { ...line, quantity: 1 }])).toThrow("Invalid preview bundle line");
    expect(adapter.cart()).toMatchObject({ count: 998, lines: [{ quantity: 998 }] });
  });

  it("does not impose the builder slot limit on the resulting preview cart", () => {
    const stored = Array.from({ length: 12 }, (_, index) => ({
      lineId: `preview:stored-${index}`, variantId: `stored-${index}`, title: `Stored ${index}`,
      quantity: 1, unitPrice: { cents: 100, currency: "USD" },
    }));
    const adapter = createPreviewCommerceAdapter({ shopId: "shop-1", lines: stored });
    adapter.addBundle([0, 1].map((index) => ({
      lineId: `preview:new-${index}`, variantId: `new-${index}`, title: `New ${index}`,
      quantity: 1, unitPrice: { cents: 100, currency: "USD" },
    })));
    expect(adapter.cart()).toMatchObject({ count: 14 });
    expect(adapter.cart().lines).toHaveLength(14);
  });

  it("round-trips a 12-slot, quantity-999 cart within the signed cookie limit", async () => {
    const lines = Array.from({ length: 12 }, (_, index) => ({
      lineId: `preview:${index}-${"l".repeat(32)}`,
      variantId: `${index}-${"v".repeat(32)}`,
      title: `${index}-${"T".repeat(32)}`,
      quantity: 999,
      unitPrice: { cents: 999999, currency: "USD" },
    }));
    const cookie = await commitPreviewCommerceSession({ shopId: "shop-1", lines });
    expect(new TextEncoder().encode(cookie).byteLength).toBeLessThanOrEqual(4096);
    const request = new Request("https://app.example.com/dashboard/store/preview", {
      headers: { cookie: cookie.split(";", 1)[0] },
    });
    const roundTrip = await readPreviewCommerceSession(request, "shop-1");
    expect(roundTrip.cart).toMatchObject({ count: 11988 });
    expect(roundTrip.cart.lines).toHaveLength(12);
    expect(roundTrip.cart.lines.every(({ quantity }) => quantity === 999)).toBe(true);
  });

  it("refuses to persist a signed preview cookie larger than 4096 bytes", async () => {
    const lines = Array.from({ length: 12 }, (_, index) => ({
      lineId: `${index}-${"l".repeat(126)}`,
      variantId: `${index}-${"v".repeat(126)}`,
      title: `${index}-${"T".repeat(118)}`,
      quantity: 1,
      unitPrice: { cents: 999999, currency: "USD" },
    }));
    await expect(commitPreviewCommerceSession({ shopId: "shop-1", lines })).rejects.toThrow("Preview cart exceeds cookie capacity");
  });
});
