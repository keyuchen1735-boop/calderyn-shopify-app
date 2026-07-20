import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { CompiledNode, RouteArtifact } from "~/lib/storefront-bundle/types";
import { compileRecipeConfig } from "../factory";
import { ROAST_ASSETS, ROAST_VIDEO_ASSET_KEYS, ROAST_VIDEO_ROLES } from "./assets";
import { ROAST_RECIPE_CONFIG } from "./bundle";

function repeatsIn(nodes: readonly CompiledNode[]): string[] {
  return nodes.flatMap((node) => node.kind === "text"
    ? []
    : [...(node.repeat ? [node.repeat.source] : []), ...repeatsIn(node.children)]);
}

function dataPaths(route: RouteArtifact): string[] {
  return route.bindings.flatMap((binding) => binding.ref.kind === "data" ? [binding.ref.path] : []);
}

describe("roast storefront recipe", () => {
  it("compiles nine preparation-first routes from live coffee and protected product options", () => {
    const { bundle, report } = compileRecipeConfig(ROAST_RECIPE_CONFIG);

    expect(bundle.source).toEqual({ kind: "recipe", templateId: "roast", templateVersion: 1 });
    expect(Object.keys(bundle.routes)).toEqual([
      "home", "collection", "product", "search", "cart", "checkout", "collections", "story", "notFound",
    ]);
    expect(ROAST_RECIPE_CONFIG.archetype).toEqual({
      composition: "origin-notebook",
      hero: "origin-brew-hero",
      scroll: "brew-notebook",
      cards: "origin-cards",
      iconography: ["brew ratio marks", "origin plot symbols"],
    });

    expect(repeatsIn(bundle.routes.home.tree)).toContain("featured.products");
    expect(repeatsIn(bundle.routes.collection.tree)).toContain("collection.products");
    expect(dataPaths(bundle.routes.collection)).toEqual(expect.arrayContaining([
      "collection.title", "collection.description", "product.title", "product.description", "product.price", "product.availability",
    ]));
    expect(dataPaths(bundle.routes.product)).toEqual(expect.arrayContaining([
      "product.title", "product.description", "product.price", "product.availability", "variant.title", "variant.availability",
    ]));
    expect(ROAST_RECIPE_CONFIG.surfaces.product.source.html).toContain("Origin facts come from the merchant record");

    expect(bundle.routes.home.interactions.transitions).not.toContainEqual(expect.objectContaining({
      action: expect.objectContaining({ type: "collection.filter" }),
    }));
    expect(ROAST_RECIPE_CONFIG.surfaces.home.source.html).toContain("Brew-method field guide");
    expect(ROAST_RECIPE_CONFIG.surfaces.home.source.html).toContain('data-cd-route="collection"');

    expect(ROAST_RECIPE_CONFIG.surfaces.product.source.html).toContain("Review the available product options");
    expect(bundle.routes.product.trustedSlots.map(({ kind }) => kind)).toEqual(expect.arrayContaining(["variantPicker", "addToCart"]));
    expect(repeatsIn(bundle.routes.product.tree)).toContain("product.variants");
    expect(bundle.routes.product.html).not.toMatch(/always available|guaranteed freshness|roasted today|ships today/i);

    expect(repeatsIn(bundle.routes.cart.tree)).toContain("cart.lines");
    expect(bundle.routes.cart.trustedSlots.map(({ kind }) => kind)).toEqual(expect.arrayContaining(["cartLineControls", "cartSummary"]));
    expect(bundle.routes.cart.html).toContain("Selected product options remain on their cart lines");
    expect(bundle.routes.checkout.decorativeHtml).toContain("Selected product options remain attached to each line");

    const customerCopy = Object.values(ROAST_RECIPE_CONFIG.surfaces)
      .map(({ source }) => source.html)
      .join(" ");
    expect(customerCopy).not.toMatch(/\b(subscription|cadence|selling plan)\b/i);
    expect(ROAST_RECIPE_CONFIG.surfaces.product.source.html).not.toMatch(/choose grind|grind option/i);

    expect(report.ok).toBe(false);
    expect(ROAST_VIDEO_ROLES).toEqual(["hero", "brew-context", "bean-grind"]);
    expect(ROAST_VIDEO_ASSET_KEYS).toEqual([
      "hero-poster", "hero-webm", "hero-mp4",
      "brew-context-poster", "brew-context-webm", "brew-context-mp4",
      "bean-grind-poster", "bean-grind-webm", "bean-grind-mp4",
    ]);
    expect(ROAST_ASSETS.entries).toEqual([]);
    expect(report.diagnostics.filter(({ code }) => code === "asset.reference_missing")).toHaveLength(9);
    for (const key of ROAST_VIDEO_ASSET_KEYS) {
      expect(report.diagnostics).toContainEqual(expect.objectContaining({
        code: "asset.reference_missing",
        path: `assets.references.${key}`,
      }));
    }
    expect(bundle.routes.home.html).toContain('data-cd-poster-asset-key="hero-poster"');
    expect(bundle.routes.story?.html).toContain('data-cd-poster-asset-key="brew-context-poster"');
    expect(bundle.routes.product.html).toContain('data-cd-poster-asset-key="bean-grind-poster"');
    expect(bundle.routes.home.css).toContain("prefers-reduced-motion:reduce");
  });

  it("ships the recipe-owned media contract and visual prototype", () => {
    for (const path of [
      "app/lib/storefront-recipes/roast/assets.ts",
      "app/lib/storefront-recipes/roast/video-brief.md",
      "app/lib/storefront-recipes/roast/video-proof.json",
      "docs/superpowers/prototypes/storefront-recipes/roast.html",
    ]) {
      expect(existsSync(resolve(process.cwd(), path)), path).toBe(true);
    }

    const prototype = readFileSync(resolve(
      process.cwd(),
      "docs/superpowers/prototypes/storefront-recipes/roast.html",
    ), "utf8");
    expect(prototype).toContain("Brew-method field guide");
    expect(prototype).not.toMatch(/\b(subscription|cadence|selling plan)\b|choose grind|grind option/i);
  });
});
