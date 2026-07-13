// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { createRuntimeAdapters, type RuntimeFetcher } from "./storefront-hydrator";

describe("runtime-1 route adapters", () => {
  it("dispatches public commerce only through the trusted Task 6 JSON bridges", async () => {
    const fetcher = vi.fn<RuntimeFetcher>(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const adapters = createRuntimeAdapters({ mode: "public", fetcher, refresh: vi.fn() });
    adapters.commerce?.dispatch({
      authorityKey: "product:p1",
      slotKind: "addToCart",
      intent: { type: "cart.add", productId: "p1", variantId: "v1", quantity: 2 },
    });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledWith("/storefront/api/cart/add", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ variantId: "v1", quantity: 2 }),
    })));
  });

  it("dispatches preview commerce only to the authenticated preview simulation action", async () => {
    const fetcher = vi.fn<RuntimeFetcher>(async () => new Response(JSON.stringify({ cart: null }), { status: 200 }));
    const adapters = createRuntimeAdapters({ mode: "preview", fetcher, refresh: vi.fn() });
    adapters.commerce?.dispatch({
      authorityKey: "cartLine:line-1",
      slotKind: "cartLineControls",
      intent: { type: "cart.remove", lineId: "line-1" },
    });
    await vi.waitFor(() => {
      const [url, init] = fetcher.mock.calls[0];
      expect(url).toBe("/dashboard/store/preview");
      expect(init?.body).toBeInstanceOf(FormData);
      expect((init?.body as FormData).get("intent")).toBe("remove");
    });
  });
});
