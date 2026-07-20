// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompiledNode, RouteArtifact } from "~/lib/storefront-bundle/types";
import { hydrateStorefront, teardownStorefront } from "~/lib/storefront-runtime/hydrate";
import { compileRecipeConfig } from "../factory";
import { LARDER_VIDEO_ASSET_KEYS, LARDER_VIDEO_ROLES } from "./assets";
import { LARDER_RECIPE_CONFIG } from "./bundle";

function repeatsIn(nodes: readonly CompiledNode[]): string[] {
  return nodes.flatMap((node) => node.kind === "text"
    ? []
    : [...(node.repeat ? [node.repeat.source] : []), ...repeatsIn(node.children)]);
}

function dataPaths(route: RouteArtifact): string[] {
  return route.bindings.flatMap((binding) => binding.ref.kind === "data" ? [binding.ref.path] : []);
}

describe("larder storefront recipe", () => {
  afterEach(() => {
    teardownStorefront();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("compiles nine warm pantry routes around live merchant products", () => {
    const { bundle, report } = compileRecipeConfig(LARDER_RECIPE_CONFIG);

    expect(report).toMatchObject({ profileVersion: 1, ok: true, diagnostics: [] });
    expect(bundle.source).toEqual({ kind: "recipe", templateId: "larder", templateVersion: 1 });
    expect(Object.keys(bundle.routes)).toEqual([
      "home", "collection", "product", "search", "cart", "checkout", "collections", "story", "notFound",
    ]);
    expect(LARDER_RECIPE_CONFIG.archetype).toEqual({
      composition: "working-pantry",
      hero: "pantry-table-hero",
      scroll: "pantry-rhythm",
      cards: "pantry-shelves",
      iconography: ["hand-cut shelf marks", "tomato and olive pantry symbols"],
    });

    expect(repeatsIn(bundle.routes.home.tree)).toContain("featured.products");
    expect(repeatsIn(bundle.routes.collection.tree)).toContain("collection.products");
    expect(dataPaths(bundle.routes.collection)).toEqual(expect.arrayContaining([
      "collection.title", "collection.description", "product.title", "product.description", "product.price", "product.availability",
    ]));
    expect(dataPaths(bundle.routes.product)).toEqual(expect.arrayContaining([
      "product.title", "product.description", "product.price", "product.availability", "variant.title", "variant.price",
    ]));
    expect(bundle.routes.product.trustedSlots.map(({ kind }) => kind)).toEqual(expect.arrayContaining(["variantPicker", "addToCart"]));
    expect(bundle.routes.collection.trustedSlots.map(({ kind }) => kind)).toContain("quickViewCommerce");
  });

  it("keeps reorder, six-slot box, and cart progress honest and stateful without unsupported subscription claims", () => {
    const { bundle } = compileRecipeConfig(LARDER_RECIPE_CONFIG);
    const homeStates = bundle.routes.home.interactions.state;

    expect(homeStates).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: expect.stringContaining("box-count"), type: "index", initial: 0, min: 0, max: 6 }),
      expect.objectContaining({ id: expect.stringContaining("reorder-cycle"), type: "enum", initial: "4-weeks", allowedValues: ["2-weeks", "4-weeks", "6-weeks"] }),
    ]));
    expect(bundle.routes.product.interactions.state.some(({ id }) => id.includes("subscribe"))).toBe(false);
    expect(bundle.routes.product.html).not.toContain('name="subscription"');
    expect(Object.values(LARDER_RECIPE_CONFIG.surfaces).map(({ source }) => source.html).join(" ")).not.toMatch(/subscri|selling.?plan|merchant plan|plan-dependent/i);
    expect(bundle.routes.home.interactions.transitions.filter(({ action }) => action.type === "state.increment")).toHaveLength(1);
    expect(bundle.routes.home.interactions.transitions.filter(({ action }) => action.type === "state.decrement")).toHaveLength(1);
    expect(dataPaths(bundle.routes.cart)).toEqual(expect.arrayContaining(["cart.count", "cart.subtotal", "cart.total"]));
    expect(bundle.routes.cart.html).toContain("of 6 pantry places filled");
    expect(repeatsIn(bundle.routes.cart.tree)).toContain("cart.lines");
    expect(bundle.routes.cart.trustedSlots.map(({ kind }) => kind)).toEqual(expect.arrayContaining(["cartLineControls", "cartSummary"]));
  });

  it("hydrates a visible six-slot board whose selected count clamps between zero and six", () => {
    const { bundle } = compileRecipeConfig(LARDER_RECIPE_CONFIG);
    document.body.innerHTML = `<div id="larder-runtime">${bundle.routes.home.html}</div>`;
    vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const root = document.getElementById("larder-runtime") as HTMLElement;
    const runtime = hydrateStorefront({
      root,
      artifact: {
        requiredCapabilities: ["localState"],
        interactions: bundle.routes.home.interactions,
        trustedSlots: [],
      },
    });
    const stateId = bundle.routes.home.interactions.state.find(({ id }) => id.includes("box-count"))!.id;
    const board = root.querySelector<HTMLElement>(".larder-box-states")!;
    const add = [...root.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) => textContent === "Fill next place")!;
    const remove = [...root.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) => textContent === "Remove place")!;
    const visibleBoard = () => [...board.children].filter((child) => child instanceof HTMLElement && !child.hidden) as HTMLElement[];

    expect(runtime.hydrated).toBe(true);
    expect(board.getAttribute("data-cd-active-index")).toBe("0");
    expect(visibleBoard()).toHaveLength(1);
    expect(visibleBoard()[0]?.querySelectorAll(".larder-box-slot")).toHaveLength(6);
    expect(visibleBoard()[0]?.textContent).toContain("0 of 6 selected");

    for (let index = 0; index < 7; index += 1) add.click();
    expect(runtime.getState()[stateId]).toBe(6);
    expect(board.getAttribute("data-cd-active-index")).toBe("6");
    expect(visibleBoard()).toHaveLength(1);
    expect(visibleBoard()[0]?.textContent).toContain("6 of 6 selected");
    expect(visibleBoard()[0]?.querySelectorAll(".larder-box-slot.is-selected")).toHaveLength(6);

    for (let index = 0; index < 7; index += 1) remove.click();
    expect(runtime.getState()[stateId]).toBe(0);
    expect(board.getAttribute("data-cd-active-index")).toBe("0");
    expect(visibleBoard()).toHaveLength(1);
  });

  it("declares approved ingredient, kitchen, and package media without replacing catalog imagery", () => {
    const { bundle } = compileRecipeConfig(LARDER_RECIPE_CONFIG);
    const productImageBindings = [bundle.routes.home, bundle.routes.collection, bundle.routes.product]
      .flatMap((route) => dataPaths(route))
      .filter((path) => path === "product.primaryImage");

    expect(LARDER_VIDEO_ROLES).toEqual(["hero", "hero-alt", "pdp-detail"]);
    expect(LARDER_VIDEO_ASSET_KEYS).toEqual([
      "hero-poster", "hero-webm", "hero-mp4",
      "hero-alt-poster", "hero-alt-webm", "hero-alt-mp4",
      "pdp-detail-poster", "pdp-detail-webm", "pdp-detail-mp4",
    ]);
    expect(LARDER_RECIPE_CONFIG.assets.entries.map(({ key }) => key)).toEqual(LARDER_VIDEO_ASSET_KEYS);
    expect(productImageBindings.length).toBeGreaterThanOrEqual(3);
    expect(bundle.routes.home.html).toContain('data-cd-poster-asset-key="hero-poster"');
    expect(bundle.routes.story?.html).toContain('data-cd-poster-asset-key="hero-alt-poster"');
    expect(bundle.routes.product.html).toContain('data-cd-poster-asset-key="pdp-detail-poster"');
    expect(bundle.routes.home.html).not.toContain('data-cd-src="hero-poster"');
  });
});
