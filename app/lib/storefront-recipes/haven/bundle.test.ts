// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompiledNode } from "~/lib/storefront-bundle/types";
import { hydrateStorefront, teardownStorefront } from "~/lib/storefront-runtime/hydrate";
import { HAVEN_VIDEO_ASSET_KEYS, HAVEN_VIDEO_ROLES } from "./assets";
import { HAVEN_RECIPE, HAVEN_RECIPE_CONFIG } from "./bundle";

function repeatsIn(nodes: readonly CompiledNode[]): string[] {
  return nodes.flatMap((node) => node.kind === "text"
    ? []
    : [...(node.repeat ? [node.repeat.source] : []), ...repeatsIn(node.children)]);
}

afterEach(() => {
  teardownStorefront();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("haven storefront recipe", () => {
  it("compiles nine spatial-quiet routes from live furniture facts and fails closed on unavailable fit claims", () => {
    const { bundle, report } = HAVEN_RECIPE;
    expect(Object.keys(bundle.routes)).toEqual([
      "home", "collection", "product", "search", "cart", "checkout", "collections", "story", "notFound",
    ]);
    expect(bundle.source).toEqual({ kind: "recipe", templateId: "haven", templateVersion: 1 });
    expect(HAVEN_RECIPE_CONFIG.archetype).toMatchObject({ composition: "spatial-studies", hero: "material-room-hero" });
    expect(repeatsIn(bundle.routes.home.tree)).toContain("featured.products");
    expect(repeatsIn(bundle.routes.collection.tree)).toContain("collection.products");
    expect(repeatsIn(bundle.routes.product.tree)).toEqual(expect.arrayContaining(["product.images", "product.variants"]));
    expect(bundle.routes.product.trustedSlots.map(({ kind }) => kind)).toEqual(expect.arrayContaining(["variantPicker", "addToCart"]));
    expect(bundle.routes.cart.trustedSlots.map(({ kind }) => kind)).toEqual(expect.arrayContaining(["cartLineControls", "cartSummary"]));

    const copy = Object.values(HAVEN_RECIPE_CONFIG.surfaces).map(({ source }) => source.html).join(" ");
    expect(copy).toContain("No room-fit result is calculated here");
    expect(copy).toContain("Delivery timing appears only when checkout provides it");
    expect(copy).not.toMatch(/fits your room|arrives? (?:in|by)|view in (?:your )?room|AR preview|swatch(?:es)? available|\b\d+(?:\.\d+)?\s*(?:in|cm|ft)\b/i);
    expect(bundle.routes.product.html).toContain("data-cd-bind-text");
    expect(bundle.routes.product.html).toContain("data-cd-bind-src");
    expect(bundle.routes.home.css).toContain("prefers-reduced-motion:reduce");

    expect(HAVEN_VIDEO_ROLES).toEqual(["hero", "hero-alt", "pdp-detail"]);
    expect(HAVEN_VIDEO_ASSET_KEYS).toHaveLength(9);
    expect(HAVEN_RECIPE_CONFIG.assets.entries).toEqual([]);
    expect(report.diagnostics.filter(({ code }) => code === "asset.reference_missing")).toHaveLength(9);
    expect(report.diagnostics.filter(({ code }) => code === "asset.media_mismatch")).toHaveLength(9);
  });

  it("hydrates the room-measurement checklist and clamps it to three evidence steps", () => {
    const route = HAVEN_RECIPE.bundle.routes.home;
    document.body.innerHTML = route.html;
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    const runtime = hydrateStorefront({ root: document.body, artifact: route, adapters: { navigate: vi.fn() } });
    expect(runtime.hydrated).toBe(true);

    const result = document.querySelector<HTMLElement>("[data-cd-active-index]")!;
    const next = [...document.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) => textContent === "Next room check")!;
    const previous = [...document.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) => textContent === "Previous room check")!;
    expect(result.dataset.cdActiveIndex).toBe("0");
    for (let index = 0; index < 5; index += 1) next.click();
    expect(result.dataset.cdActiveIndex).toBe("3");
    expect([...result.children].filter((child) => !(child as HTMLElement).hidden)[0]?.textContent).toContain("checkout");
    for (let index = 0; index < 5; index += 1) previous.click();
    expect(result.dataset.cdActiveIndex).toBe("0");
  });
});
