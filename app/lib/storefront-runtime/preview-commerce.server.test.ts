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
});
