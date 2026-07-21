// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompiledNode } from "~/lib/storefront-bundle/types";
import { hydrateStorefront, teardownStorefront } from "~/lib/storefront-runtime/hydrate";
import { HAVEN_ASSET_KEYS } from "./assets";
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
  it("compiles nine spatial-quiet routes with a trusted sticky purchase column and fails closed on unavailable fit claims", () => {
    const { bundle, report } = HAVEN_RECIPE;
    expect(Object.keys(bundle.routes)).toEqual([
      "home", "collection", "product", "search", "cart", "checkout", "collections", "story", "notFound",
    ]);
    expect(bundle.source).toEqual({ kind: "recipe", templateId: "haven", templateVersion: 1 });
    expect(HAVEN_RECIPE_CONFIG.archetype).toMatchObject({ composition: "spatial-studies", hero: "material-room-hero" });
    expect(repeatsIn(bundle.routes.home.tree)).toContain("featured.products");
    expect(repeatsIn(bundle.routes.collection.tree)).toContain("collection.products");
    expect(repeatsIn(bundle.routes.product.tree)).toEqual(expect.arrayContaining(["product.images", "product.variants", "product.facts"]));
    expect(bundle.routes.product.trustedSlots.map(({ kind }) => kind)).toEqual(expect.arrayContaining(["variantPicker", "addToCart"]));
    expect(bundle.routes.cart.trustedSlots.map(({ kind }) => kind)).toEqual(expect.arrayContaining(["cartLineControls", "cartSummary"]));

    const copy = Object.values(HAVEN_RECIPE_CONFIG.surfaces).map(({ source }) => source.html).join(" ");
    expect(copy).toContain("No automatic room-fit result is calculated");
    expect(copy).toContain("Compare the listed dimensions with your own room measurements");
    expect(copy).not.toContain("use only the merchant-supplied product description");
    expect(HAVEN_RECIPE_CONFIG.concept.noveltySignature).not.toContain("measurement-checklist");
    expect(copy).toContain("Delivery timing appears only when checkout provides it");
    expect(copy).not.toMatch(/fits your room|arrives? (?:in|by)|view in (?:your )?room|AR preview|swatch(?:es)? available|\b\d+(?:\.\d+)?\s*(?:in|cm|ft)\b/i);
    expect(bundle.routes.product.html).toContain("data-cd-bind-text");
    expect(bundle.routes.product.html).toContain("data-cd-bind-src");
    expect(bundle.routes.home.css).toContain("prefers-reduced-motion:reduce");

    const source = document.createElement("div");
    source.innerHTML = HAVEN_RECIPE_CONFIG.surfaces.product.source.html;
    const purchaseColumn = source.querySelector(".haven-purchase-column");
    expect(purchaseColumn?.querySelector('[data-cd-slot="variantPicker"]')).not.toBeNull();
    expect(purchaseColumn?.querySelector('[data-cd-slot="addToCart"]')).not.toBeNull();
    expect(purchaseColumn?.querySelectorAll('.haven-material-tray [data-cd-repeat="product.images"] img')).toHaveLength(1);
    expect(purchaseColumn?.querySelectorAll('.haven-material-tray [data-cd-repeat="product.variants"]')).toHaveLength(1);
    expect(purchaseColumn?.querySelectorAll('.haven-product-facts [data-cd-repeat="product.facts"]')).toHaveLength(1);
    expect(purchaseColumn?.querySelector('.haven-product-facts [data-cd-text="fact.label"]')).not.toBeNull();
    expect(purchaseColumn?.querySelector('.haven-product-facts [data-cd-text="fact.value"]')).not.toBeNull();
    expect(purchaseColumn?.querySelector('.haven-product-facts [data-cd-href="fact.url"]')).not.toBeNull();

    expect(HAVEN_ASSET_KEYS).toEqual(["hero"]);
    expect(HAVEN_RECIPE_CONFIG.assets.entries).toEqual([
      expect.objectContaining({ key: "hero", contentHash: expect.stringMatching(/^[a-f0-9]{64}$/), mediaType: "image/webp" }),
    ]);
    expect(HAVEN_RECIPE_CONFIG.assets.entries[0]?.byteSize).toBeGreaterThan(0);
    expect(report.ok).toBe(true);
    expect(report.diagnostics).toEqual([]);
    expect(bundle.routes.home.html).toContain('class="haven-hero-image" data-cd-asset-key="hero"');
    expect(Object.values(bundle.routes).map((route) => "html" in route ? route.html : route.decorativeHtml).join(" ")).not.toContain("data-cd-video");
  });

  it("hydrates the room-planning checklist and clamps it to four evidence-only panels", () => {
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
