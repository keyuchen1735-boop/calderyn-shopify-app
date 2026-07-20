// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hydrateStorefront } from "../../storefront-runtime/hydrate";
import { compileRecipeConfig } from "../factory";
import { ATELIER_ASSETS } from "./assets";
import { ATELIER_RECIPE_CONFIG } from "./bundle";

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
    const sharedVideoValidatorDiagnostics = new Set([
      "route.html_mismatch",
      "tree.control_attribute",
    ]);
    expect(
      new Set(
        result.report.diagnostics
          .filter(({ code }) => !sharedVideoValidatorDiagnostics.has(code))
          .map(({ code }) => code),
      ),
    ).toEqual(new Set(["asset.reference_missing"]));
  });

  it("binds live garments and variants to the fit and purchase flow", () => {
    const { bundle } = compileRecipeConfig(ATELIER_RECIPE_CONFIG);
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
        "variant.title",
        "variant.availability",
      ]),
    );
    expect(product.trustedSlots.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(["variantPicker", "addToCart"]),
    );
    expect(
      product.trustedSlots.filter(({ kind }) => kind === "addToCart"),
    ).toHaveLength(2);
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

  it("uses one honest collections link and only runtime-supported availability filters", () => {
    const { bundle } = compileRecipeConfig(ATELIER_RECIPE_CONFIG);
    const collectionsHtml =
      ATELIER_RECIPE_CONFIG.surfaces.collections.source.html;
    const filters = bundle.routes.collection.interactions.transitions
      .filter(({ action }) => action.type === "collection.filter")
      .map(({ action }) =>
        action.type === "collection.filter" ? action.facetId : null,
      );

    expect(collectionsHtml.match(/data-cd-route="collection"/g)).toHaveLength(
      1,
    );
    expect(collectionsHtml).toContain("All products");
    expect(collectionsHtml).not.toMatch(
      /Everyday layers|Soft tailoring|Foundation jerseys|Warm-weather cloth/,
    );
    expect(new Set(filters)).toEqual(new Set(["available"]));
    expect(ATELIER_RECIPE_CONFIG.surfaces.collection.source.html).not.toContain(
      'data-cd-facet="fit"',
    );
  });

  it("records the shared protected-host layout blocker without styling commerce internals", () => {
    const productSource = ATELIER_RECIPE_CONFIG.surfaces.product.source;
    expect(productSource.html).toContain('class="atelier-purchase-desktop"');
    expect(productSource.html).toContain('class="atelier-purchase-mobile"');
    expect(productSource.css).not.toMatch(/atelier-purchase-(desktop|mobile)/);
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
                "</main><section>",
                '</main><section class="atelier-purchase-frame">',
              ),
              css: `${productSource.css}.atelier-purchase-frame{position:sticky;bottom:0}`,
            },
          },
        },
      }),
    ).toThrow(/protected commerce host or ancestor/);
  });

  it("declares exactly three poster-first video briefs while media proof remains honestly blocked", () => {
    const { bundle, report } = compileRecipeConfig(ATELIER_RECIPE_CONFIG);
    const brief = readFileSync(
      "app/lib/storefront-recipes/atelier/video-brief.md",
      "utf8",
    );
    const html = [bundle.routes.home.html, bundle.routes.product.html].join(
      "\n",
    );
    const keys = [
      "hero-poster",
      "hero-webm",
      "hero-mp4",
      "hero-alt-poster",
      "hero-alt-webm",
      "hero-alt-mp4",
      "pdp-detail-poster",
      "pdp-detail-webm",
      "pdp-detail-mp4",
    ];

    expect(html.match(/data-cd-video/g) ?? []).toHaveLength(3);
    expect(
      brief.match(
        /^\[VIDEO BRIEF — atelier \/ (hero|hero-alt|pdp-detail)\]$/gm,
      ),
    ).toHaveLength(3);
    for (const key of keys) expect(html).toContain(key);
    expect(ATELIER_ASSETS.entries).toEqual([]);
    expect(report.ok).toBe(false);
    expect(
      report.diagnostics
        .filter(({ code }) => code === "asset.reference_missing")
        .map(({ path }) => path.replace("assets.references.", ""))
        .sort(),
    ).toEqual([...keys].sort());
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
