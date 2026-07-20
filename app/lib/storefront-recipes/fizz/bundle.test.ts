import { describe, expect, it } from "vitest";
import type { CompiledNode } from "~/lib/storefront-bundle/types";
import { FIZZ_VIDEO_ASSET_KEYS, FIZZ_VIDEO_ROLES } from "./assets";
import { FIZZ_RECIPE, FIZZ_RECIPE_CONFIG } from "./bundle";

function repeatsIn(nodes: readonly CompiledNode[]): string[] {
  return nodes.flatMap((node) => node.kind === "text"
    ? []
    : [...(node.repeat ? [node.repeat.source] : []), ...repeatsIn(node.children)]);
}

describe("fizz storefront recipe", () => {
  it("compiles nine live-catalog routes with an honest flavor playground", () => {
    const { bundle, report } = FIZZ_RECIPE;

    expect(Object.keys(bundle.routes)).toEqual([
      "home", "collection", "product", "search", "cart", "checkout", "collections", "story", "notFound",
    ]);
    expect(bundle.source).toEqual({ kind: "recipe", templateId: "fizz", templateVersion: 1 });
    expect(FIZZ_RECIPE_CONFIG.archetype.composition).toBe("flavor-playground");
    expect(bundle.routes.home.html).toContain("Find your fizz");
    expect(bundle.routes.home.html).toContain("Build a variety pack");
    expect(repeatsIn(bundle.routes.home.tree)).toContain("featured.products");
    expect(bundle.routes.home.interactions.state.filter(({ id }) => id.includes("fizz-quiz-"))).toHaveLength(3);
    expect(bundle.routes.home.interactions.state.filter(({ id }) => id.includes("fizz-pack-"))).toHaveLength(4);
    expect(bundle.routes.product.trustedSlots.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(["variantPicker", "addToCart"]),
    );
    expect(bundle.routes.cart.html).toContain("fizz-cart-progress");
    expect(bundle.routes.cart.trustedSlots.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(["cartLineControls", "cartSummary"]),
    );

    const copy = Object.values(FIZZ_RECIPE_CONFIG.surfaces).map(({ source }) => source.html).join(" ");
    expect(copy).not.toMatch(/free shipping|guaranteed|limited time|\d+% off/i);
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
});
