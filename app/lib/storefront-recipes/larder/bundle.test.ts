import { describe, expect, it } from "vitest";
import type { CompiledNode, RouteArtifact } from "~/lib/storefront-bundle/types";
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

  it("uses the protected six-slot builder and exposes subscriptions only through live product controls", () => {
    const { bundle } = compileRecipeConfig(LARDER_RECIPE_CONFIG);
    expect(bundle.routes.home.interactions.state).toEqual([]);
    expect(bundle.routes.home.trustedSlots).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "bundleBuilder", slotCount: 6, hostSize: "block" }),
    ]));
    expect(bundle.routes.home.html).not.toMatch(/Fill next place|Remove place|Reorder rhythm/);
    expect(bundle.routes.product.html).toContain("Subscription choices appear here only when this merchant offers them");
    expect(bundle.routes.product.trustedSlots.map(({ kind }) => kind)).toEqual(expect.arrayContaining(["variantPicker", "addToCart"]));
    expect(dataPaths(bundle.routes.cart)).toEqual(expect.arrayContaining(["cart.count", "cart.subtotal", "cart.total"]));
    expect(bundle.routes.cart.html).toContain("of 6 pantry places filled");
    expect(repeatsIn(bundle.routes.cart.tree)).toContain("cart.lines");
    expect(bundle.routes.cart.trustedSlots.map(({ kind }) => kind)).toEqual(expect.arrayContaining(["cartLineControls", "cartSummary"]));
  });

  it("compiles a six-item commerce host without recipe-authored cart controls", () => {
    const { bundle } = compileRecipeConfig(LARDER_RECIPE_CONFIG);
    const slot = bundle.routes.home.trustedSlots.find(({ kind }) => kind === "bundleBuilder");
    expect(slot).toMatchObject({ slotCount: 6 });
    expect(bundle.routes.home.html).toContain(`data-cd-trusted-slot-id="${slot?.id}"`);
    expect(bundle.routes.home.html).not.toContain("data-cd-action=\"cart.addBundle\"");
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
