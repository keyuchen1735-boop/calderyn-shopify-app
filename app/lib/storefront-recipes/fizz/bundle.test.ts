// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompiledNode } from "~/lib/storefront-bundle/types";
import { hydrateStorefront, teardownStorefront } from "~/lib/storefront-runtime/hydrate";
import { FIZZ_STATIC_ASSET_KEYS } from "./assets";
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
    expect(bundle.routes.home.html).toContain("Build a four-flavor pack");
    expect(repeatsIn(bundle.routes.home.tree)).toContain("featured.products");
    expect(bundle.routes.home.interactions.state).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "enum", initial: "explore", allowedValues: ["explore", "bright", "juicy", "crisp"] }),
    ]));
    expect(bundle.routes.home.trustedSlots).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "bundleBuilder", slotCount: 4, hostSize: "block" }),
    ]));
    expect(bundle.routes.product.trustedSlots.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(["variantPicker", "addToCart"]),
    );
    expect(repeatsIn(bundle.routes.product.tree)).toContain("product.facts");
    expect(bundle.routes.cart.html).toContain("fizz-cart-progress");
    expect(bundle.routes.cart.trustedSlots.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(["cartLineControls", "cartSummary"]),
    );

    const copy = Object.values(FIZZ_RECIPE_CONFIG.surfaces).map(({ source }) => source.html).join(" ");
    expect(copy).not.toMatch(/free shipping|guaranteed|limited time|\d+% off/i);
    expect(bundle.routes.home.html).not.toMatch(/fit this flavor direction/i);
    expect(copy).toContain("Eligible first-order offers appear at checkout.");

    expect(report).toMatchObject({ ok: true, diagnostics: [] });
    expect(FIZZ_STATIC_ASSET_KEYS).toEqual(["hero"]);
    expect(FIZZ_RECIPE_CONFIG.assets.entries).toEqual([
      expect.objectContaining({
        key: "hero",
        mediaType: "image/webp",
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    expect(FIZZ_RECIPE_CONFIG.assets.entries[0]!.byteSize).toBeGreaterThan(0);
    expect(bundle.routes.home.html).toContain('data-cd-asset-key="hero"');
    expect(Object.values(bundle.routes).map((route) => "html" in route ? route.html : route.decorativeHtml).join(" ")).not.toContain("<video");
    expect(bundle.routes.home.css).toContain("prefers-reduced-motion:reduce");
    expect(bundle.routes.home.css).toContain("scroll-snap-type:x mandatory");
  });

  it("covers Baymard-depth fizz discovery without leaving merchant truth", () => {
    const { bundle } = FIZZ_RECIPE;

    expect(bundle.routes.home.html).toContain("Flavor doors");
    expect(FIZZ_RECIPE_CONFIG.surfaces.home.source.html).toContain('data-cd-route="collections"');
    expect(bundle.routes.collections!.html).toContain("Flavor map");
    expect(bundle.routes.collections!.html).toContain("Collection lanes use this merchant catalog");
    expect(bundle.routes.collection.html).toContain("Flavor map");
    expect(bundle.routes.collection.html).toContain("Sibling flavor lanes");
    expect(bundle.routes.collection.html).toContain("Applied filter");
    expect(bundle.routes.collection.interactions.transitions.map((transition) => transition.action.type)).toEqual(expect.arrayContaining(["collection.filter", "collection.sort"]));
    expect(bundle.routes.collection.trustedSlots.map(({ kind }) => kind)).toContain("quickViewCommerce");
    expect(repeatsIn(bundle.routes.product.tree)).toEqual(expect.arrayContaining(["product.images", "product.facts", "related.products"]));
    expect(bundle.routes.product.html).toContain("Policy links and checkout terms are provided by the merchant");
    expect(bundle.routes.search.html).toContain("Result count");
    expect(bundle.routes.search.html).toContain("Recover by browsing flavor lanes");
    expect(bundle.routes.cart.html).toContain("Review line quantities, current totals, and merchant policies before checkout");
    expect(bundle.routes.checkout.decorativeHtml).toContain("Protected checkout continues below");
  });

  it("hydrates truthful flavor guidance while commerce stays in the protected pack builder", () => {
    const route = FIZZ_RECIPE.bundle.routes.home;
    document.body.innerHTML = route.html;
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    const runtime = hydrateStorefront({
      root: document.body,
      artifact: {
        ...route,
        requiredCapabilities: route.requiredCapabilities.filter((capability) => capability !== "commerce"),
        trustedSlots: [],
      },
      adapters: { navigate: vi.fn() },
    });
    expect(runtime.hydrated).toBe(true);

    const quizResult = document.querySelector<HTMLElement>("[data-cd-class-token]")!;
    expect(quizResult.dataset.cdClassToken).toBe("explore");
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(({ value }) => value === "bright")!.click();
    expect(quizResult.dataset.cdClassToken).toBe("bright");
    expect(quizResult.textContent).toContain("sharp, tart, or dry");
    expect(quizResult.textContent).toContain("Browse every live product");

    expect(route.trustedSlots).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "bundleBuilder", slotCount: 4 }),
    ]));
    expect(route.html).not.toMatch(/Add a comparison pick|Remove a comparison pick/);
  });
});
