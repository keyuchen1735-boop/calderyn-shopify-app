// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompiledNode } from "~/lib/storefront-bundle/types";
import { hydrateStorefront, teardownStorefront } from "~/lib/storefront-runtime/hydrate";
import { FIZZ_VIDEO_ASSET_KEYS, FIZZ_VIDEO_ROLES } from "./assets";
import { FIZZ_RECIPE, FIZZ_RECIPE_CONFIG } from "./bundle";

function repeatsIn(nodes: readonly CompiledNode[]): string[] {
  return nodes.flatMap((node) => node.kind === "text"
    ? []
    : [...(node.repeat ? [node.repeat.source] : []), ...repeatsIn(node.children)]);
}

describe("fizz storefront recipe", () => {
  afterEach(() => {
    teardownStorefront();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("compiles nine live-catalog routes with an honest flavor playground", () => {
    const { bundle, report } = FIZZ_RECIPE;

    expect(Object.keys(bundle.routes)).toEqual([
      "home", "collection", "product", "search", "cart", "checkout", "collections", "story", "notFound",
    ]);
    expect(bundle.source).toEqual({ kind: "recipe", templateId: "fizz", templateVersion: 1 });
    expect(FIZZ_RECIPE_CONFIG.archetype.composition).toBe("flavor-playground");
    expect(bundle.routes.home.html).toContain("Find your fizz");
    expect(bundle.routes.home.html).toContain("Plan up to four picks");
    expect(repeatsIn(bundle.routes.home.tree)).toContain("featured.products");
    expect(bundle.routes.home.interactions.state).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "enum", initial: "explore", allowedValues: ["explore", "bright", "juicy", "crisp"] }),
      expect.objectContaining({ type: "index", initial: 0, min: 0, max: 4 }),
    ]));
    expect(bundle.routes.product.trustedSlots.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(["variantPicker", "addToCart"]),
    );
    expect(bundle.routes.cart.html).toContain("fizz-cart-progress");
    expect(bundle.routes.cart.trustedSlots.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(["cartLineControls", "cartSummary"]),
    );

    const copy = Object.values(FIZZ_RECIPE_CONFIG.surfaces).map(({ source }) => source.html).join(" ");
    expect(copy).not.toMatch(/free shipping|guaranteed|limited time|\d+% off/i);
    expect(bundle.routes.home.html).not.toMatch(/build a variety pack|fit this flavor direction/i);
    expect(copy).toContain("Eligible first-order offers appear at checkout.");

    expect(FIZZ_VIDEO_ROLES).toEqual(["hero", "hero-alt", "pdp-detail"]);
    expect(FIZZ_VIDEO_ASSET_KEYS).toHaveLength(9);
    expect(FIZZ_RECIPE_CONFIG.assets.entries).toEqual([]);
    expect(report.diagnostics.filter(({ code }) => code === "asset.reference_missing")).toHaveLength(9);
    expect(bundle.routes.home.html).toContain('data-cd-poster-asset-key="hero-poster"');
    expect(bundle.routes.story?.html).toContain('data-cd-poster-asset-key="hero-alt-poster"');
    expect(bundle.routes.product.html).toContain('data-cd-poster-asset-key="pdp-detail-poster"');
    expect(bundle.routes.home.css).toContain("prefers-reduced-motion:reduce");
  });

  it("hydrates truthful flavor guidance and clamps the comparison planner to four", () => {
    const route = FIZZ_RECIPE.bundle.routes.home;
    document.body.innerHTML = route.html;
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);

    const runtime = hydrateStorefront({
      root: document.body,
      artifact: route,
      adapters: { navigate: vi.fn() },
    });
    expect(runtime.hydrated).toBe(true);

    const quizResult = document.querySelector<HTMLElement>("[data-cd-class-token]")!;
    expect(quizResult.dataset.cdClassToken).toBe("explore");
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(({ value }) => value === "bright")!.click();
    expect(quizResult.dataset.cdClassToken).toBe("bright");
    expect(quizResult.textContent).toContain("sharp, tart, or dry");
    expect(quizResult.textContent).toContain("Browse every live product");

    const planner = document.querySelector<HTMLElement>("[data-cd-active-index]")!;
    const increment = [...document.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) => textContent === "Add a comparison pick")!;
    const decrement = [...document.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) => textContent === "Remove a comparison pick")!;
    expect(planner.dataset.cdActiveIndex).toBe("0");
    for (let index = 0; index < 6; index += 1) increment.click();
    expect(planner.dataset.cdActiveIndex).toBe("4");
    const visibleResult = [...planner.children].filter((child) => !(child as HTMLElement).hidden);
    expect(visibleResult).toHaveLength(1);
    expect(visibleResult[0]?.textContent).toContain("Planner full");
    for (let index = 0; index < 6; index += 1) decrement.click();
    expect(planner.dataset.cdActiveIndex).toBe("0");
  });
});
