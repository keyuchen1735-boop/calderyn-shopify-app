import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { CompiledNode, RouteArtifact } from "~/lib/storefront-bundle/types";
import { compileRecipeConfig } from "../factory";
import { EMBER_ASSETS, EMBER_VIDEO_ASSET_KEYS, EMBER_VIDEO_ROLES } from "./assets";
import { EMBER_RECIPE_CONFIG } from "./bundle";

function repeatsIn(nodes: readonly CompiledNode[]): string[] {
  return nodes.flatMap((node) => node.kind === "text"
    ? []
    : [...(node.repeat ? [node.repeat.source] : []), ...repeatsIn(node.children)]);
}

function dataPaths(route: RouteArtifact): string[] {
  return route.bindings.flatMap((binding) => binding.ref.kind === "data" ? [binding.ref.path] : []);
}

describe("ember storefront recipe", () => {
  it("compiles nine heat-led routes from merchant facts without fabricating proof or urgency", () => {
    const { bundle, report } = compileRecipeConfig(EMBER_RECIPE_CONFIG);

    expect(bundle.source).toEqual({ kind: "recipe", templateId: "ember", templateVersion: 1 });
    expect(Object.keys(bundle.routes)).toEqual([
      "home", "collection", "product", "search", "cart", "checkout", "collections", "story", "notFound",
    ]);
    expect(EMBER_RECIPE_CONFIG.archetype).toEqual({
      composition: "tasting-counter",
      hero: "heat-spectrum-hero",
      scroll: "heat-tasting",
      cards: "tasting-flights",
      iconography: ["pepper-scale marks", "raw tasting stamps"],
    });

    expect(repeatsIn(bundle.routes.home.tree)).toContain("featured.products");
    expect(repeatsIn(bundle.routes.collection.tree)).toContain("collection.products");
    expect(dataPaths(bundle.routes.collection)).toEqual(expect.arrayContaining([
      "collection.title", "collection.description", "product.title", "product.description", "product.price", "product.availability",
    ]));
    expect(dataPaths(bundle.routes.product)).toEqual(expect.arrayContaining([
      "product.title", "product.description", "product.price", "product.availability", "variant.title", "variant.price",
    ]));

    const filters = bundle.routes.collection.interactions.transitions
      .filter(({ action }) => action.type === "collection.filter")
      .map(({ action }) => action.type === "collection.filter" ? action.facetId : "");
    expect(filters).toEqual(["tag", "tag", "tag", "tag", "tag"]);
    expect(EMBER_RECIPE_CONFIG.surfaces.collection.source.html).toContain("merchant-supplied heat tags");

    const homeHtml = bundle.routes.home.html;
    expect(homeHtml).toContain("Build a tasting flight");
    expect(homeHtml).toContain("ember-flight");
    expect(bundle.routes.home.trustedSlots.some(({ kind, scopeId }) => kind === "quickViewCommerce" && scopeId)).toBe(true);
    expect(homeHtml).toContain('class="ember-ugc"');
    expect(bundle.routes.home.interactions.state.some(({ id, initial }) => id.endsWith("ugc-hidden") && initial === true)).toBe(true);
    expect(bundle.routes.home.interactions.bindings.some(({ stateId, property }) => stateId.endsWith("ugc-hidden") && property === "hidden")).toBe(true);
    expect(homeHtml).not.toMatch(/★★★★★|“[^”]+”|verified buyer/i);

    expect(EMBER_RECIPE_CONFIG.surfaces.product.source.html).toContain('data-cd-text="product.availability"');
    expect(bundle.routes.product.trustedSlots.map(({ kind }) => kind)).toEqual(expect.arrayContaining(["variantPicker", "addToCart"]));
    expect(bundle.routes.product.html).not.toMatch(/only \d+|selling fast|ships (?:today|tomorrow)|low stock/i);
    expect(bundle.routes.cart.trustedSlots.map(({ kind }) => kind)).toEqual(expect.arrayContaining(["cartLineControls", "cartSummary"]));

    expect(report.ok).toBe(false);
    expect(EMBER_VIDEO_ROLES).toEqual(["hero", "hero-alt", "pdp-detail"]);
    expect(EMBER_VIDEO_ASSET_KEYS).toEqual([
      "hero-poster", "hero-webm", "hero-mp4",
      "hero-alt-poster", "hero-alt-webm", "hero-alt-mp4",
      "pdp-detail-poster", "pdp-detail-webm", "pdp-detail-mp4",
    ]);
    expect(EMBER_ASSETS.entries).toEqual([]);
    expect(report.diagnostics.filter(({ code }) => code === "asset.reference_missing")).toHaveLength(9);
    for (const key of EMBER_VIDEO_ASSET_KEYS) {
      expect(report.diagnostics).toContainEqual(expect.objectContaining({
        code: "asset.reference_missing",
        path: `assets.references.${key}`,
      }));
    }
    expect(homeHtml).toContain('data-cd-poster-asset-key="hero-poster"');
    expect(bundle.routes.story?.html).toContain('data-cd-poster-asset-key="hero-alt-poster"');
    expect(bundle.routes.product.html).toContain('data-cd-poster-asset-key="pdp-detail-poster"');
    expect(bundle.routes.home.css).toContain("@media(max-width:720px)");
    expect(bundle.routes.home.css).toContain("min-height:44px");
    expect(bundle.routes.home.css).toContain("prefers-reduced-motion:reduce");
  });

  it("ships the recipe-owned media contract and visual prototype", () => {
    for (const path of [
      "app/lib/storefront-recipes/ember/assets.ts",
      "app/lib/storefront-recipes/ember/video-brief.md",
      "app/lib/storefront-recipes/ember/video-proof.json",
      "docs/superpowers/prototypes/storefront-recipes/ember.html",
    ]) {
      expect(existsSync(resolve(process.cwd(), path)), path).toBe(true);
    }
  });
});
