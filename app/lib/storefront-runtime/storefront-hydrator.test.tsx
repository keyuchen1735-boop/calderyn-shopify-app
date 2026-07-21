// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { STOREFRONT_RECIPES } from "~/lib/storefront-recipes";
import { FIZZ_RECIPE_CONFIG } from "~/lib/storefront-recipes/fizz/bundle";
import { compileRecipeConfig } from "~/lib/storefront-recipes/factory";
import { LARDER_RECIPE_CONFIG } from "~/lib/storefront-recipes/larder/bundle";
import { compileBundle } from "~/lib/storefront-compiler/compile";
import { VALID_BUNDLE_SOURCE } from "~/lib/storefront-compiler/__fixtures__/valid-bundle";
import { hydrateStorefront, teardownStorefront } from "./hydrate";
import { trustedCommerceRoot } from "./trusted-roots";
import { renderStorefrontRoute } from "./render";
import {
  createRuntimeAdapters,
  placeQuickViewCommerceInCards,
  type RuntimeFetcher,
} from "./storefront-hydrator";
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
  it("hydrates an incomplete bundle disabled and submits only live completed variants", async () => {
    const fetcher = vi.fn<RuntimeFetcher>(async () => new Response("{}", { status: 200 }));
    const second = { ...quickViewData.featuredProducts[0]!, id: "p2", title: "Refill", variants: [
      { ...quickViewData.featuredProducts[0]!.variants[0]!, id: "sold", available: false, availability: "Sold out" as const },
      { ...quickViewData.featuredProducts[0]!.variants[1]!, id: "v3" },
    ] };
    const adapters = createRuntimeAdapters({ mode: "public", data: { ...quickViewData, featuredProducts: [...quickViewData.featuredProducts, second] }, fetcher, refresh: vi.fn() });
    const host = document.createElement("div");
    const shadowRoot = host.attachShadow({ mode: "open" });
    adapters.commerce?.mount({ host, shadowRoot, authorityKey: "bundle:catalog",
      slot: { id: "bundle", kind: "bundleBuilder", slotCount: 2, hostSize: "block", themeTokenIds: [] },
      bridge: (intent) => adapters.commerce?.dispatch({ authorityKey: "bundle:catalog", slotKind: "bundleBuilder", intent }),
    });
    const selects = shadowRoot.querySelectorAll<HTMLSelectElement>("select");
    const button = shadowRoot.querySelector<HTMLButtonElement>("button")!;
    expect(button.disabled).toBe(true);
    selects[0]!.value = "p1"; selects[0]!.dispatchEvent(new Event("change"));
    selects[1]!.value = "v2"; selects[1]!.dispatchEvent(new Event("change"));
    selects[2]!.value = "p2"; selects[2]!.dispatchEvent(new Event("change"));
    expect([...selects[3]!.options].map((option) => option.value)).not.toContain("sold");
    selects[3]!.value = "v3"; selects[3]!.dispatchEvent(new Event("change"));
    expect(button.disabled).toBe(false);
    button.click();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledWith("/storefront/api/cart/add-bundle", expect.objectContaining({
      body: JSON.stringify({ lines: [{ variantId: "v2", quantity: 1 }, { variantId: "v3", quantity: 1 }] }),
    })));
  });

  it("submits a completed bundle to the authenticated preview action", async () => {
    const fetcher = vi.fn<RuntimeFetcher>(async () => new Response("{}", { status: 200 }));
    const adapters = createRuntimeAdapters({
      mode: "preview", previewTemplateId: "fizz", data: quickViewData, fetcher, refresh: vi.fn(),
    });
    const host = document.createElement("div");
    const shadowRoot = host.attachShadow({ mode: "open" });
    adapters.commerce?.mount({
      host, shadowRoot, authorityKey: "bundle:catalog",
      slot: { id: "bundle", kind: "bundleBuilder", slotCount: 2, hostSize: "block", themeTokenIds: [] },
      bridge: (intent) => adapters.commerce?.dispatch({ authorityKey: "bundle:catalog", slotKind: "bundleBuilder", intent }),
    });
    const selects = shadowRoot.querySelectorAll<HTMLSelectElement>("select");
    for (const [product, variant] of [[selects[0], selects[1]], [selects[2], selects[3]]] as const) {
      product!.value = "p1"; product!.dispatchEvent(new Event("change"));
      variant!.value = "v1"; variant!.dispatchEvent(new Event("change"));
    }
    shadowRoot.querySelector<HTMLButtonElement>("button")!.click();

    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("/dashboard/store/preview?template=fizz");
    expect((init?.body as FormData).get("intent")).toBe("addBundle");
    expect(JSON.parse(String((init?.body as FormData).get("lines")))).toEqual([
      { variantId: "v1", quantity: 1 }, { variantId: "v1", quantity: 1 },
    ]);
  });

  it.each([
    [6, "commons-index"],
    [4, "atelier-nine"],
  ] as const)("hydrates a generic compiled %i-slot builder and submits every selection in %s preview", async (slotCount, templateId) => {
    const source = structuredClone(VALID_BUNDLE_SOURCE);
    source.routes.home.html = `<main><section data-cd-slot="bundleBuilder" data-cd-bundle-slots="${slotCount}"></section></main>`;
    source.routes.home.css = "";
    const artifact = compileBundle(source).bundle.routes.home;
    document.body.innerHTML = renderToStaticMarkup(renderStorefrontRoute({
      routeId: "home", artifact, data: quickViewData, nonce: "test",
    }).element);
    const fetcher = vi.fn<RuntimeFetcher>(async () => new Response("{}", { status: 200 }));
    const adapters = createRuntimeAdapters({ mode: "preview", previewTemplateId: templateId, data: quickViewData, fetcher, refresh: vi.fn() });
    const runtime = hydrateStorefront({ root: document.body, artifact, adapters });
    expect(runtime.error).toBeUndefined();
    expect(runtime.hydrated).toBe(true);
    const shadowRoot = trustedCommerceRoot(document.querySelector<HTMLElement>('[data-cd-trusted-slot="bundleBuilder"]')!)!;
    const selects = shadowRoot.querySelectorAll<HTMLSelectElement>("select");
    for (let index = 0; index < slotCount; index += 1) {
      selects[index * 2]!.value = "p1"; selects[index * 2]!.dispatchEvent(new Event("change"));
      selects[index * 2 + 1]!.value = "v1"; selects[index * 2 + 1]!.dispatchEvent(new Event("change"));
    }
    shadowRoot.querySelector<HTMLButtonElement>("button")!.click();

    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    const body = fetcher.mock.calls[0]![1]!.body as FormData;
    expect(JSON.parse(String(body.get("lines")))).toHaveLength(slotCount);
    teardownStorefront();
  });

  it.each([
    ["larder", 6, LARDER_RECIPE_CONFIG],
    ["fizz", 4, FIZZ_RECIPE_CONFIG],
  ] as const)("hydrates the real %s recipe builder and submits all %i slots in preview", async (templateId, slotCount, config) => {
    const artifact = compileRecipeConfig(config).bundle.routes.home;
    expect(artifact.trustedSlots).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "bundleBuilder", slotCount }),
    ]));
    document.body.innerHTML = renderToStaticMarkup(renderStorefrontRoute({
      routeId: "home", artifact, data: quickViewData, nonce: "test",
    }).element);
    const fetcher = vi.fn<RuntimeFetcher>(async () => new Response("{}", { status: 200 }));
    const adapters = createRuntimeAdapters({ mode: "preview", previewTemplateId: templateId, data: quickViewData, fetcher, refresh: vi.fn() });
    const runtime = hydrateStorefront({ root: document.body, artifact, adapters });
    expect(runtime.error).toBeUndefined();
    const shadowRoot = trustedCommerceRoot(document.querySelector<HTMLElement>('[data-cd-trusted-slot="bundleBuilder"]')!)!;
    const selects = shadowRoot.querySelectorAll<HTMLSelectElement>("select");
    for (let index = 0; index < slotCount; index += 1) {
      selects[index * 2]!.value = "p1"; selects[index * 2]!.dispatchEvent(new Event("change"));
      selects[index * 2 + 1]!.value = "v1"; selects[index * 2 + 1]!.dispatchEvent(new Event("change"));
    }
    shadowRoot.querySelector<HTMLButtonElement>("button")!.click();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    expect(JSON.parse(String((fetcher.mock.calls[0]![1]!.body as FormData).get("lines")))).toHaveLength(slotCount);
    teardownStorefront();
  });

  it("moves detached quick-buy controls into their matching product cards", () => {
    const route = document.createElement("div");
    route.innerHTML = `
      <div class="rail" data-cd-repeat-owner="true" data-cd-compiler-id="product-list">
        <article><h2 data-cd-bind-text="title-binding">Field kit</h2><div class="commerce-target"><a class="commerce-fallback">View</a></div></article>
      </div>
      <div class="rail" data-cd-repeat-owner="true" data-cd-compiler-id="product-list">
        <article><h2 data-cd-bind-text="title-binding">Field kit refill</h2><div class="commerce-target"><a class="commerce-fallback">View</a></div></article>
      </div>
      <section data-cd-repeat-owner="true">
        <div data-cd-compiler-id="quick-slot" data-cd-trusted-slot="quickViewCommerce"></div>
      </section>
      <section data-cd-repeat-owner="true">
        <div data-cd-compiler-id="quick-slot" data-cd-trusted-slot="quickViewCommerce"></div>
      </section>`;
    placeQuickViewCommerceInCards(route, {
      bindings: [{
        id: "title-binding", targetId: "title-node", kind: "text",
        ref: { kind: "data", path: "product.title", scopeId: "product-scope" },
      }],
      trustedSlots: [{
        id: "quick-slot", kind: "quickViewCommerce", scopeId: "detached-scope",
        hostSize: "inline", themeTokenIds: [],
      }],
    });

    expect(route.querySelectorAll("article [data-cd-trusted-slot='quickViewCommerce']")).toHaveLength(2);
    expect(route.querySelectorAll(".commerce-target > [data-cd-trusted-slot='quickViewCommerce']")).toHaveLength(2);
    expect(route.querySelectorAll(".commerce-fallback")).toHaveLength(0);
    expect(route.querySelectorAll(".rail")).toHaveLength(1);
    expect(route.querySelectorAll(".rail > article")).toHaveLength(2);
    expect(route.querySelectorAll("section[data-cd-repeat-owner]")).toHaveLength(0);
  });

  it("places purchase controls inside product cards for every recipe listing", () => {
    const product = quickViewData.featuredProducts[0]!;
    const products = [product, {
      ...product,
      id: "p2",
      handle: "field-kit-refill",
      title: "Field kit refill",
      variants: product.variants.map((variant) => ({ ...variant, id: `${variant.id}-refill` })),
    }];
    const routeData = {
      home: { ...quickViewData, featuredProducts: products },
      collection: {
        ...quickViewData,
        collection: {
          id: "collection-1", handle: "all", title: "All", description: "",
          image: null, productCount: products.length, products, nextCursor: null,
        },
      },
      search: {
        ...quickViewData,
        search: {
          query: "field", results: products,
          facets: { categories: [], tags: [], collections: [] }, total: products.length, nextCursor: null,
        },
      },
    };

    for (const recipe of STOREFRONT_RECIPES) {
      for (const routeId of ["home", "collection", "search"] as const) {
        const artifact = recipe.bundle.routes[routeId];
        const root = document.createElement("div");
        root.innerHTML = renderToStaticMarkup(renderStorefrontRoute({
          routeId, artifact, data: routeData[routeId], nonce: "test",
        }).element);
        const route = root.firstElementChild as HTMLElement;

        placeQuickViewCommerceInCards(route, artifact);

        const controls = [...route.querySelectorAll('[data-cd-trusted-slot="quickViewCommerce"]')];
        if (artifact.trustedSlots.some((slot) => slot.kind === "quickViewCommerce")) {
          expect(controls, `${recipe.config.templateId}/${routeId}`).not.toHaveLength(0);
          expect(controls.every((control) => control.closest("article")),
            `${recipe.config.templateId}/${routeId}`).toBe(true);
        }
        const layoutOwners = [...route.querySelectorAll<HTMLElement>('[data-cd-repeat-owner="true"]')]
          .filter((owner) => owner.tagName !== "ARTICLE" && owner.querySelector("article"));
        for (const owner of layoutOwners) {
          const siblings = [...(owner.parentElement?.children ?? [])].filter((candidate) =>
            candidate.getAttribute("data-cd-compiler-id") === owner.dataset.cdCompilerId
          );
          expect(siblings, `${recipe.config.templateId}/${routeId} product layout`).toHaveLength(1);
        }
      }
    }
  });

  it("provides purchase controls on every recipe home and collection listing", () => {
    for (const recipe of STOREFRONT_RECIPES) {
      for (const routeId of ["home", "collection"] as const) {
        expect(
          recipe.bundle.routes[routeId].trustedSlots.some((slot) => slot.kind === "quickViewCommerce"),
          `${recipe.config.templateId}/${routeId}`,
        ).toBe(true);
      }
    }
  });

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

  it("navigates closed merchant fact filters and clears the stale cursor", () => {
    window.history.replaceState({}, "", "/storefront/collections/furniture?cursor=stale");
    const assign = vi.fn();
    const adapters = createRuntimeAdapters({ mode: "public", locationAssign: assign });
    adapters.collection?.({ type: "filter", facetId: "fact-material", value: "Walnut" });
    expect(assign).toHaveBeenCalledWith("/storefront/collections/furniture?filter.fact-material=Walnut");
    window.history.replaceState({}, "", "/storefront/search?q=chair&cursor=stale");
    adapters.collection?.({ type: "filter", facetId: "fact-compatibility", value: "Model X" });
    expect(assign).toHaveBeenLastCalledWith("/storefront/search?q=chair&fact.compatibility=Model+X");
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

  it("sends trusted personalization inputs through the commerce bridge without pricing fields", async () => {
    const fetcher = vi.fn<RuntimeFetcher>(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const adapters = createRuntimeAdapters({
      mode: "public",
      data: { ...quickViewData, product: quickViewData.featuredProducts[0]! },
      fetcher,
      refresh: vi.fn(),
    });
    const host = document.createElement("div");
    const shadowRoot = host.attachShadow({ mode: "open" });
    const slot = {
      id: "slot", kind: "addToCart", hostSize: "block", themeTokenIds: [],
      personalizationFields: ["engraving", "giftNote"],
    } as const;
    adapters.commerce?.mount({
      host,
      shadowRoot,
      authorityKey: "product:p1",
      slot: slot as never,
      bridge: (intent) => adapters.commerce?.dispatch({ authorityKey: "product:p1", slotKind: "addToCart", intent }),
    });

    const engraving = shadowRoot.querySelector<HTMLInputElement>('input[name="engraving"]');
    const giftNote = shadowRoot.querySelector<HTMLTextAreaElement>('textarea[name="giftNote"]');
    expect(engraving?.maxLength).toBe(240);
    expect(giftNote?.maxLength).toBe(240);
    engraving!.value = "Always";
    giftNote!.value = "For you";
    shadowRoot.querySelector<HTMLButtonElement>("button")!.click();

    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledWith("/storefront/api/cart/add", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        variantId: "v1",
        quantity: 1,
        personalization: { engraving: "Always", giftNote: "For you" },
      }),
    })));
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).not.toHaveProperty("price");
  });

  it("shows only eligible purchase plans in the trusted slot and submits the selected id", async () => {
    const fetcher = vi.fn<RuntimeFetcher>(async () => new Response("{}", { status: 200 }));
    const product = structuredClone(quickViewData.featuredProducts[0]!);
    product.variants[0]!.sellingPlans = [{
      id: "plan-monthly", name: "Monthly delivery", cadence: "Every month",
      priceAdjustment: null,
    }];
    const adapters = createRuntimeAdapters({ mode: "public", data: { ...quickViewData, product }, fetcher, refresh: vi.fn() });
    const host = document.createElement("div");
    const shadowRoot = host.attachShadow({ mode: "open" });
    adapters.commerce?.mount({
      host, shadowRoot, authorityKey: "product:p1",
      slot: { id: "slot", kind: "addToCart", hostSize: "block", themeTokenIds: [] } as never,
      bridge: (intent) => adapters.commerce?.dispatch({ authorityKey: "product:p1", slotKind: "addToCart", intent }),
    });
    const select = shadowRoot.querySelector<HTMLSelectElement>('select[aria-label="Purchase option"]')!;
    expect(select.hidden).toBe(false);
    expect([...select.options].map((option) => option.value)).toEqual(["", "plan-monthly"]);
    select.value = "plan-monthly";
    shadowRoot.querySelector<HTMLButtonElement>("button")!.click();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledWith("/storefront/api/cart/add", expect.objectContaining({
      body: JSON.stringify({ variantId: "v1", quantity: 1, sellingPlanId: "plan-monthly" }),
    })));
    const pickerHost = document.createElement("div");
    const pickerRoot = pickerHost.attachShadow({ mode: "open" });
    adapters.commerce?.mount({
      host: pickerHost, shadowRoot: pickerRoot, authorityKey: "product:p1",
      slot: { id: "picker", kind: "variantPicker", hostSize: "block", themeTokenIds: [] } as never,
      bridge: vi.fn(),
    });
    const picker = pickerRoot.querySelector("select")!;
    picker.value = "v2";
    picker.dispatchEvent(new Event("change"));
    expect(select.hidden).toBe(true);
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

  it("omits the redundant variant selector for a single purchasable option", () => {
    const product = {
      ...quickViewData.featuredProducts[0]!,
      variants: [quickViewData.featuredProducts[0]!.variants[0]!],
    };
    const adapters = createRuntimeAdapters({
      mode: "public", data: { ...quickViewData, featuredProducts: [product] },
    });
    const host = document.createElement("div");
    const shadowRoot = host.attachShadow({ mode: "open" });

    adapters.commerce?.mount({
      host,
      shadowRoot,
      authorityKey: "product:p1",
      slot: { id: "slot", kind: "quickViewCommerce", hostSize: "inline", themeTokenIds: [] },
      bridge: vi.fn(),
    });

    expect(shadowRoot.querySelector("select")).toBeNull();
    expect(shadowRoot.querySelector("button")?.textContent).toBe("Add to cart");
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

  it("uses validated recipe commerce colors for trusted controls", () => {
    const adapters = createRuntimeAdapters({ mode: "public", data: quickViewData });
    const host = document.createElement("div");
    host.style.setProperty("--paper", "#f4efe3");
    host.style.setProperty("--forest", "#163d31");
    host.style.setProperty("--acid", "#c8ff32");
    host.style.setProperty("--commerce-surface", "var(--paper)");
    host.style.setProperty("--commerce-foreground", "var(--forest)");
    host.style.setProperty("--commerce-accent", "var(--acid)");
    host.style.setProperty("--commerce-accent-foreground", "var(--forest)");
    document.body.append(host);
    const shadowRoot = host.attachShadow({ mode: "open" });

    adapters.commerce?.mount({
      host,
      shadowRoot,
      authorityKey: "product:p1",
      slot: { id: "slot", kind: "quickViewCommerce", hostSize: "inline", themeTokenIds: [] },
      bridge: vi.fn(),
    });

    const style = shadowRoot.querySelector("style")?.textContent ?? "";
    expect(style).toContain("background:#f4efe3;color:#163d31");
    expect(style).toContain("background:#c8ff32;color:#163d31");
  });

  it("rejects low-contrast and transparent recipe commerce colors", () => {
    const adapters = createRuntimeAdapters({ mode: "public", data: quickViewData });
    const host = document.createElement("div");
    host.style.setProperty("--commerce-surface", "#ffffff");
    host.style.setProperty("--commerce-foreground", "#ffffff");
    host.style.setProperty("--commerce-accent", "rgba(0, 0, 0, 0)");
    host.style.setProperty("--commerce-accent-foreground", "#ffffff");
    document.body.append(host);
    const shadowRoot = host.attachShadow({ mode: "open" });

    adapters.commerce?.mount({
      host,
      shadowRoot,
      authorityKey: "product:p1",
      slot: { id: "slot", kind: "quickViewCommerce", hostSize: "inline", themeTokenIds: [] },
      bridge: vi.fn(),
    });

    const style = shadowRoot.querySelector("style")?.textContent ?? "";
    expect(style).toContain("background:rgb(20, 22, 19);color:rgb(255, 255, 255)");
    expect(style).not.toContain("background:#ffffff;color:#ffffff");
    expect(style).not.toContain("rgba(0, 0, 0, 0)");
  });
});
