// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { createRuntimeAdapters, type RuntimeFetcher } from "./storefront-hydrator";
import type { PublicPresentationData } from "./public-data.server";

const quickViewData: PublicPresentationData = {
  store: { name: "Test store", logo: null },
  policyLinks: [],
  product: null,
  collection: null,
  featuredProducts: [{
    id: "p1", handle: "field-kit", title: "Field kit", description: "A complete kit.",
    primaryImage: null, images: [], options: [{ name: "Size", values: ["Small", "Large"] }],
    variants: [
      { id: "v1", title: "Small", price: { cents: 2500, currency: "USD" }, compareAtPrice: null, availability: "In stock", available: true },
      { id: "v2", title: "Large", price: { cents: 3000, currency: "USD" }, compareAtPrice: null, availability: "In stock", available: true },
    ],
    price: { cents: 2500, currency: "USD" }, compareAtPrice: null, availability: "In stock",
  }],
  relatedProducts: [], search: null, cart: null, notFound: null,
};

describe("runtime-1 route adapters", () => {
  it("retains a bounded input query for a separate search submit control", () => {
    const assign = vi.fn();
    const adapters = createRuntimeAdapters({ mode: "public", locationAssign: assign });
    const typed = "x".repeat(240);

    adapters.search?.({ type: "update", query: typed });
    adapters.search?.({ type: "submit", query: "submit-button-value" });

    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(`/storefront/search?q=${"x".repeat(200)}`);
  });

  it("resets the pending search query when search is cleared", () => {
    const assign = vi.fn();
    const adapters = createRuntimeAdapters({ mode: "public", locationAssign: assign });

    adapters.search?.({ type: "update", query: "stale" });
    adapters.search?.({ type: "clear" });
    adapters.search?.({ type: "submit", query: "fresh" });

    expect(assign).toHaveBeenNthCalledWith(1, "/storefront/search?q=");
    expect(assign).toHaveBeenNthCalledWith(2, "/storefront/search?q=fresh");
  });

  it("drops a stale collection cursor when sort changes its Task 6 fingerprint", () => {
    window.history.replaceState({}, "", "/storefront/collections/featured?cursor=stale&sort=title_asc");
    const assign = vi.fn();
    const adapters = createRuntimeAdapters({ mode: "public", locationAssign: assign });
    adapters.collection?.({ type: "sort", value: "price_desc" });
    expect(assign).toHaveBeenCalledWith("/storefront/collections/featured?sort=price_desc");
  });

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
    const adapters = createRuntimeAdapters({ mode: "preview", previewTemplateId: "atelier-nine", fetcher, refresh: vi.fn() });
    adapters.commerce?.dispatch({
      authorityKey: "cartLine:line-1",
      slotKind: "cartLineControls",
      intent: { type: "cart.remove", lineId: "line-1" },
    });
    await vi.waitFor(() => {
      const [url, init] = fetcher.mock.calls[0];
      expect(url).toBe("/dashboard/store/preview?template=atelier-nine");
      expect(init?.body).toBeInstanceOf(FormData);
      expect((init?.body as FormData).get("intent")).toBe("remove");
    });
  });

  it("mounts quick view as an accessible variant-and-add commerce interaction", async () => {
    const fetcher = vi.fn<RuntimeFetcher>(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const adapters = createRuntimeAdapters({
      mode: "public", data: quickViewData, fetcher, refresh: vi.fn(),
    });
    const host = document.createElement("div");
    const shadowRoot = host.attachShadow({ mode: "open" });
    adapters.commerce?.mount({
      host,
      shadowRoot,
      authorityKey: "product:p1",
      slot: { id: "cd-home-slot-1", kind: "quickViewCommerce", scopeId: "cd-home-scope-1", hostSize: "inline", themeTokenIds: [] },
      bridge: (intent) => adapters.commerce?.dispatch({ authorityKey: "product:p1", slotKind: "quickViewCommerce", intent }),
    });

    const region = shadowRoot.querySelector<HTMLElement>("[role='group']");
    const select = shadowRoot.querySelector<HTMLSelectElement>("select");
    const button = shadowRoot.querySelector<HTMLButtonElement>("button");
    expect(region?.getAttribute("aria-label")).toContain("Field kit");
    expect(select?.getAttribute("aria-label")).toContain("Field kit");
    expect([...select!.options].map((option) => option.textContent)).toEqual(["Small", "Large"]);
    expect(button?.textContent).toMatch(/add/i);

    select!.value = "v2";
    select!.dispatchEvent(new Event("change"));
    button!.click();

    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledWith("/storefront/api/cart/add", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ variantId: "v2", quantity: 1 }),
    })));
  });

  it("applies square yellow commerce controls only to an explicitly opted-in bundle", () => {
    const mountStyle = (squareAccentCommerce: boolean) => {
      const adapters = createRuntimeAdapters({ mode: "public", data: quickViewData, squareAccentCommerce });
      const host = document.createElement("div");
      host.style.setProperty("--ink", "#231e27");
      host.style.setProperty("--milk", "#f4f0eb");
      host.style.setProperty("--yellow", "#ecff5b");
      document.body.append(host);
      const shadowRoot = host.attachShadow({ mode: "open" });
      adapters.commerce?.mount({
        host,
        shadowRoot,
        authorityKey: "product:p1",
        slot: { id: "slot", kind: "quickViewCommerce", hostSize: "inline", themeTokenIds: ["milk", "ink", "yellow"] },
        bridge: vi.fn(),
      });
      return shadowRoot.querySelector("style")?.textContent ?? "";
    };

    expect(mountStyle(false)).toContain("border-radius:.2rem");
    expect(mountStyle(false)).not.toContain("background:#ecff5b");
    expect(mountStyle(true)).toContain("border-radius:0");
    expect(mountStyle(true)).toContain("background:#ecff5b");
  });
});
