// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { hydrateStorefront } from "../../storefront-runtime/hydrate";
import { compileRecipeConfig } from "../factory";
import { ATELIER_ASSETS, ATELIER_ASSET_KEYS } from "./assets";
import { ATELIER_RECIPE, ATELIER_RECIPE_CONFIG } from "./bundle";

const ROUTES = [
  "home",
  "collections",
  "collection",
  "product",
  "search",
  "story",
  "cart",
  "checkout",
  "notFound",
] as const;

describe("Atelier storefront recipe", () => {
  it("meets the Taste storefront hardening contract", () => {
    const surfaces = ATELIER_RECIPE_CONFIG.surfaces;
    const visibleCopy = Object.values(surfaces).map(({ source }) => source.html).join(" ");

    expect(surfaces.collections.source.html).toContain('data-cd-repeat="featured.collections"');
    expect(surfaces.collections.source.html).toContain('data-cd-key="collection.id"');
    expect(surfaces.collections.source.html).toContain('data-cd-param-handle="collection.handle"');
    expect(surfaces.collections.source.html).toContain('data-cd-text="collection.title"');
    expect(visibleCopy).not.toMatch(/[—–]|Catalog door 0\d|Fabric study 0\d|>0[1-3]<\/|404/);
    expect(surfaces.home.source.html.match(/class="atelier-hero-line"/g)).toHaveLength(2);
    expect(surfaces.home.source.css).toContain(".atelier-hero h1{max-width:8ch;margin:14px 0;font-family:var(--font-display);font-size:clamp(3.875rem,9vw,6rem)");
    expect(ATELIER_RECIPE_CONFIG.designSystem.globalCss).toContain(".atelier-hero-line{display:block");
    expect(surfaces.home.source.css).toContain("@media(max-width:760px)");
    expect(surfaces.home.source.css).toContain("@media(prefers-reduced-motion:reduce)");
    expect(surfaces.product.source.html).toContain('data-cd-slot="variantPicker"');
    expect(surfaces.product.source.html).toContain('data-cd-slot="addToCart"');
    expect(surfaces.cart.source.html).toContain('data-cd-route="collection"');
  });

  it("compiles nine distinct fit-laboratory routes without Atelier Grid's magazine structure", () => {
    const result = compileRecipeConfig(ATELIER_RECIPE_CONFIG);

    expect(ROUTES.every((route) => ATELIER_RECIPE_CONFIG.surfaces[route])).toBe(
      true,
    );
    expect(
      new Set(
        ROUTES.map((route) => ATELIER_RECIPE_CONFIG.surfaces[route].signature),
      ).size,
    ).toBe(9);
    expect(ATELIER_RECIPE_CONFIG.archetype).toMatchObject({
      composition: "fit-laboratory",
      hero: "fabric-study-hero",
      scroll: "fit-study",
      cards: "garment-studies",
    });
    expect(ATELIER_RECIPE_CONFIG.designSystem.tokens).toMatchObject({
      stone: "#ebe6dd",
      oxblood: "#681f2b",
    });
    expect(JSON.stringify(ATELIER_RECIPE_CONFIG)).not.toMatch(
      /asymmetric-magazine|editorial-grid-hero|magazine-grid/,
    );
    expect(
      new Set(
        result.report.diagnostics
          .map(({ code }) => code),
      ),
    ).toEqual(new Set());
  });



  it("deepens Atelier into merchant-bound catalog discovery without unsupported claims", () => {
    const { bundle } = compileRecipeConfig(ATELIER_RECIPE_CONFIG);
    const sourceByRoute = Object.fromEntries(
      Object.entries(ATELIER_RECIPE_CONFIG.surfaces).map(([route, surface]) => [
        route,
        surface.source.html,
      ]),
    );

    expect(sourceByRoute.home).toContain("atelier-collection-hooks");
    expect(sourceByRoute.home).toContain('data-cd-route="collections"');
    expect(sourceByRoute.home).toContain('data-cd-repeat="featured.products"');
    expect(sourceByRoute.collections).toContain("atelier-index-composition");
    expect(sourceByRoute.collections).toContain('data-cd-route="collection"');
    expect(sourceByRoute.collection).toContain("atelier-breadcrumbs");
    expect(sourceByRoute.collection).toContain("atelier-sibling-nav");
    expect(sourceByRoute.collection).toContain("atelier-applied-filter");
    expect(sourceByRoute.collection).toContain('data-cd-action="collection.filter"');
    expect(sourceByRoute.collection).toContain('data-cd-action="collection.sort"');
    expect(bundle.routes.collection.trustedSlots.map(({ kind }) => kind)).toContain(
      "quickViewCommerce",
    );
    expect(sourceByRoute.product).toContain('data-cd-repeat="related.products"');
    expect(sourceByRoute.product).toContain("atelier-policy-reassurance");
    expect(bundle.routes.product.trustedSlots.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(["variantPicker", "addToCart"]),
    );
    expect(sourceByRoute.search).toContain("atelier-search-count");
    expect(sourceByRoute.search).toContain("atelier-search-recovery");
    expect(sourceByRoute.cart).toContain("atelier-cart-policy");
    expect(ATELIER_RECIPE_CONFIG.surfaces.checkout.source.html).toContain(
      "protected checkout flow",
    );
    expect(`${sourceByRoute.home}${sourceByRoute.collection}${sourceByRoute.product}${sourceByRoute.cart}`).not.toMatch(
      /customer reviews?|discount|limited|scarcity|guaranteed delivery|arrives by|clinical|performance/i,
    );
  });


  it("binds live garments and variants to the fit and purchase flow", () => {
    const { bundle } = ATELIER_RECIPE;
    const product = bundle.routes.product;

    expect(
      bundle.routes.home.bindings.map(({ ref }) =>
        ref.kind === "data" ? ref.path : null,
      ),
    ).toEqual(
      expect.arrayContaining([
        "product.primaryImage",
        "product.title",
        "product.price",
        "product.availability",
      ]),
    );
    expect(ATELIER_RECIPE_CONFIG.surfaces.product.source.html).toContain(
      'data-cd-repeat="product.variants"',
    );
    expect(
      product.bindings.map(({ ref }) =>
        ref.kind === "data" ? ref.path : null,
      ),
    ).toEqual(
      expect.arrayContaining([
        "product.title",
        "product.description",
        "product.price",
        "product.availability",
        "fact.label",
        "fact.value",
        "fact.url",
        "variant.title",
        "variant.availability",
      ]),
    );
    expect(product.trustedSlots.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(["variantPicker", "addToCart"]),
    );
    expect(
      product.trustedSlots.filter(({ kind }) => kind === "addToCart"),
    ).toHaveLength(1);
    expect(ATELIER_RECIPE_CONFIG.surfaces.product.source.html).toContain(
      'data-cd-repeat="product.facts"',
    );
    expect(ATELIER_RECIPE_CONFIG.surfaces.product.source.html).toContain(
      'data-cd-href="fact.url"',
    );
    expect(ATELIER_RECIPE_CONFIG.surfaces.product.source.html).toContain(
      'data-cd-slot="addToCart" data-cd-product="product.id"',
    );
    expect(bundle.shell.trustedSlots.map(({ kind }) => kind)).toContain(
      "cartDrawer",
    );
  });

  it("keeps controls visible while preference state advances to honest guidance", () => {
    const { bundle } = compileRecipeConfig(ATELIER_RECIPE_CONFIG);
    const product = bundle.routes.product;
    document.head.innerHTML = `<style>${product.css}</style>`;
    document.body.innerHTML = `<div id="atelier-runtime" data-cd-bundle="product">${product.html}</div>`;
    const root = document.getElementById("atelier-runtime") as HTMLElement;
    root.querySelectorAll("video").forEach((video) => video.remove());
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({
        matches: true,
        addEventListener() {},
        removeEventListener() {},
      }),
    });
    const runtime = hydrateStorefront({
      root,
      artifact: {
        requiredCapabilities: ["localState"],
        interactions: product.interactions,
        trustedSlots: [],
      },
    });
    expect(runtime.hydrated).toBe(true);

    const finder = root.querySelector<HTMLElement>(".atelier-fit-finder")!;
    const steps = root.querySelector<HTMLElement>(".atelier-fit-steps")!;
    const controls = root.querySelector<HTMLElement>(".atelier-fit-controls")!;
    const close = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Closer",
    )!;
    const next = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Next",
    )!;

    expect(controls.hidden).toBe(false);
    close.click();
    next.click();
    next.click();
    expect(finder.dataset.cdClassToken).toBe("close");
    expect(controls.hidden).toBe(false);
    expect(steps.children[2]).toMatchObject({ hidden: false });
    expect(steps.children[0]).toMatchObject({ hidden: true });
    expect(steps.children[2]?.textContent).toContain(
      "Guidance confidence: preference only",
    );
    expect(steps.children[2]?.textContent).toContain(
      "Confirm the selected live variant and its availability",
    );
    expect(
      window.getComputedStyle(
        root.querySelector<HTMLElement>(".atelier-result-close")!,
      ).display,
    ).toBe("inline");
    expect(
      window.getComputedStyle(
        root.querySelector<HTMLElement>(".atelier-result-regular")!,
      ).display,
    ).toBe("none");
    runtime.teardown();
  });

  it("uses merchant-bound catalog links and only runtime-supported availability filters", () => {
    const { bundle } = compileRecipeConfig(ATELIER_RECIPE_CONFIG);
    const collectionsHtml =
      ATELIER_RECIPE_CONFIG.surfaces.collections.source.html;
    const filters = bundle.routes.collection.interactions.transitions
      .filter(({ action }) => action.type === "collection.filter")
      .map(({ action }) =>
        action.type === "collection.filter" ? action.facetId : null,
      );

    expect(collectionsHtml.match(/data-cd-route="collection"/g)?.length).toBeGreaterThanOrEqual(
      1,
    );
    expect(collectionsHtml).toContain("Garment collection");
    expect(collectionsHtml).toContain("atelier-index-composition");
    expect(new Set(filters)).toEqual(new Set(["available"]));
    expect(ATELIER_RECIPE_CONFIG.surfaces.collection.source.html).not.toContain(
      'data-cd-facet="fit"',
    );
  });

  it("keeps one adjacent protected purchase host until shared responsive layout exists", () => {
    const productSource = ATELIER_RECIPE_CONFIG.surfaces.product.source;
    document.body.innerHTML = productSource.html;
    const purchaseHosts = document.querySelectorAll(
      '[data-cd-slot="addToCart"]',
    );
    expect(purchaseHosts).toHaveLength(1);
    expect(
      document.querySelector(
        'main [data-cd-slot="addToCart"]',
      ),
    ).toBe(purchaseHosts[0]);
    expect(purchaseHosts[0]?.previousElementSibling).toMatchObject({
      dataset: { cdSlot: "variantPicker" },
    });
    expect(productSource.html).not.toMatch(/atelier-purchase-(desktop|mobile)/);
    expect(productSource.css).not.toMatch(/atelier-purchase/);
    expect(() =>
      compileRecipeConfig({
        ...ATELIER_RECIPE_CONFIG,
        surfaces: {
          ...ATELIER_RECIPE_CONFIG.surfaces,
          product: {
            ...ATELIER_RECIPE_CONFIG.surfaces.product,
            source: {
              ...productSource,
              html: productSource.html.replace(
                '<section><div data-cd-slot="variantPicker"',
                '<section class="atelier-purchase-frame"><div data-cd-slot="variantPicker"',
              ),
              css: `${productSource.css}.atelier-purchase-frame{position:sticky;bottom:0}`,
            },
          },
        },
      }),
    ).toThrow(/protected commerce host or ancestor/);
  });

  it("requires one static hero while secondary media uses CSS and live product imagery", () => {
    const { bundle, report } = compileRecipeConfig(ATELIER_RECIPE_CONFIG);
    const html = Object.values(bundle.routes).flatMap((route) => "html" in route ? [route.html] : []).join("\n");

    expect(ATELIER_ASSET_KEYS).toEqual(["hero"]);
    expect(bundle.routes.home.html).toMatch(/<img[^>]*class="atelier-hero-image"[^>]*data-cd-asset-key="hero"/);
    expect(html).not.toContain("data-cd-video");
    expect(ATELIER_ASSETS.entries).toEqual([
      expect.objectContaining({ key: "hero", mediaType: "image/webp" }),
    ]);
    expect(ATELIER_ASSETS.entries[0]?.byteSize).toBeGreaterThan(0);
    expect(ATELIER_ASSETS.entries[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(report.ok).toBe(true);
    expect(
      report.diagnostics
        .filter(({ code }) => code === "asset.reference_missing")
        .map(({ path }) => path.replace("assets.references.", ""))
    ).toEqual([]);
  });

  it("provides protected cart controls and a live order ledger", () => {
    const { bundle } = compileRecipeConfig(ATELIER_RECIPE_CONFIG);
    expect(bundle.routes.cart.trustedSlots.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(["cartLineControls", "cartSummary"]),
    );
    expect(
      bundle.routes.cart.bindings.map(({ ref }) =>
        ref.kind === "data" ? ref.path : null,
      ),
    ).toEqual(
      expect.arrayContaining([
        "cartLine.title",
        "cartLine.quantity",
        "cartLine.total",
        "cart.subtotal",
      ]),
    );
  });
});
