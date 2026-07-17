import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RouteArtifact } from "~/lib/storefront-bundle/types";
import { ATELIER_GRID_ASSETS } from "./assets";
import { ATELIER_GRID_BUNDLE, ATELIER_GRID_RECIPE } from "./bundle";

const ROUTES = ["home", "collection", "product", "search", "cart"] as const;
const CANONICAL_HTML = readFileSync(path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../public/atelier-grid/index.html",
), "utf8");

function bindingPaths(route: RouteArtifact): string[] {
  return route.bindings.flatMap((binding) => binding.ref.kind === "data" ? [binding.ref.path] : []);
}

describe("Atelier Grid recipe contract", () => {
  it("preserves the canonical storefront composition while products stay merchant-bound", () => {
    const recipeHtml = `${ATELIER_GRID_RECIPE.config.surfaces.shell.source.html}\n${ATELIER_GRID_RECIPE.config.surfaces.home.source.html}`;
    const recipeCss = `${ATELIER_GRID_RECIPE.config.designSystem.globalCss}\n${ATELIER_GRID_RECIPE.config.surfaces.home.source.css}`;
    for (const className of [
      "announcement", "header-row", "hero-lower", "edition", "catalog-side",
      "catalog-main", "product-grid", "manifesto-copy", "manifesto-index", "shipping-bar",
    ]) {
      expect(CANONICAL_HTML).toMatch(new RegExp(`class="[^"]*\\b${className}\\b`));
      expect(recipeHtml).toContain(className);
      expect(recipeCss).toContain(`.${className}`);
    }
    expect(ATELIER_GRID_RECIPE.config.surfaces.shell.source.html).toContain("<footer");
    expect(ATELIER_GRID_RECIPE.config.surfaces.shell.source.html).toContain('data-cd-policy-links');
    expect(ATELIER_GRID_RECIPE.config.surfaces.home.source.html).not.toContain("<footer");
    expect(ATELIER_GRID_RECIPE.config.surfaces.home.source.html).not.toContain('data-cd-policy-links');
    expect(ATELIER_GRID_RECIPE.config.surfaces.shell.source.html).toContain('data-cd-slot="cartDrawer"');
  });

  it("compiles the approved asymmetric editorial identity through validation profile v1", () => {
    expect(ATELIER_GRID_RECIPE.report).toMatchObject({ ok: true, profileVersion: 1 });
    expect(ATELIER_GRID_BUNDLE.source).toEqual({ kind: "recipe", templateId: "atelier-nine", templateVersion: 3 });
    expect(ATELIER_GRID_BUNDLE.validationProfileVersion).toBe(1);
    expect(ATELIER_GRID_BUNDLE.designSystem).toMatchObject({
      displayFontId: "archivo-narrow",
      bodyFontId: "source-serif-4",
      iconStyle: expect.stringMatching(/thin/i),
      motionStyle: expect.stringMatching(/restrained/i),
    });
    expect(ATELIER_GRID_RECIPE.config.archetype).toMatchObject({
      composition: "asymmetric-magazine",
      hero: "editorial-grid-hero",
      scroll: "restrained-editorial",
      cards: "magazine-grid",
    });
    expect(new Set(Object.values(ATELIER_GRID_RECIPE.config.surfaces).map((surface) => surface.signature)).size).toBe(7);
  });

  it("owns the approved hero and keeps all media references closed", () => {
    expect(ATELIER_GRID_ASSETS.entries).toEqual([{
      key: "hero",
      contentHash: "bf43ff158ad36f2399f116949983f821578bec4e4bbf7baad34791604ac90fc9",
      mediaType: "image/webp",
      byteSize: 44708,
    }]);
    expect(ATELIER_GRID_BUNDLE.assets).toEqual(ATELIER_GRID_ASSETS);
    expect(ATELIER_GRID_BUNDLE.routes.home.html).toContain('data-cd-asset-key="hero"');
    expect(JSON.stringify(ATELIER_GRID_BUNDLE)).not.toMatch(/https?:|url\(/i);
  });

  it("provides merchant-bound merchandising on every browse and purchase route", () => {
    expect(bindingPaths(ATELIER_GRID_BUNDLE.shell)).toContain("store.name");
    expect(bindingPaths(ATELIER_GRID_BUNDLE.routes.home)).toEqual(expect.arrayContaining(["product.title", "product.price"]));
    expect(bindingPaths(ATELIER_GRID_BUNDLE.routes.collection)).toEqual(expect.arrayContaining(["collection.title", "collection.description", "product.title", "product.price"]));
    expect(bindingPaths(ATELIER_GRID_BUNDLE.routes.product)).toEqual(expect.arrayContaining(["product.title", "product.description", "product.price", "product.availability"]));
    expect(bindingPaths(ATELIER_GRID_BUNDLE.routes.search)).toEqual(expect.arrayContaining(["search.query", "product.title", "product.price"]));
    expect(bindingPaths(ATELIER_GRID_BUNDLE.routes.cart)).toEqual(expect.arrayContaining(["cartLine.title", "cartLine.quantity", "cartLine.total", "cart.subtotal", "cart.total"]));
    expect(ATELIER_GRID_BUNDLE.routes.checkout.bindings.map((binding) => binding.ref.kind === "data" ? binding.ref.path : null)).toContain("store.name");
  });

  it("uses protected commerce islands and declared interactions instead of inert controls", () => {
    expect(ATELIER_GRID_BUNDLE.shell.trustedSlots.map((slot) => slot.kind)).toContain("cartDrawer");
    expect(ATELIER_GRID_BUNDLE.routes.home.trustedSlots.map((slot) => slot.kind)).toContain("quickViewCommerce");
    expect(ATELIER_GRID_BUNDLE.routes.collection.trustedSlots.map((slot) => slot.kind)).toContain("quickViewCommerce");
    expect(ATELIER_GRID_BUNDLE.routes.product.trustedSlots.map((slot) => slot.kind)).toEqual(expect.arrayContaining(["variantPicker", "addToCart"]));
    expect(ATELIER_GRID_BUNDLE.routes.search.trustedSlots.map((slot) => slot.kind)).toContain("quickViewCommerce");
    expect(ATELIER_GRID_BUNDLE.routes.cart.trustedSlots.map((slot) => slot.kind)).toEqual(expect.arrayContaining(["cartLineControls", "cartSummary"]));
    expect(ATELIER_GRID_BUNDLE.routes.checkout.layout).toMatchObject({
      columnMode: "summaryAside",
      sectionOrder: ["contact", "shipping", "delivery", "consent", "payment", "summary"],
    });
    expect(ATELIER_GRID_BUNDLE.routes.collection.interactions.transitions.map((transition) => transition.action.type)).toEqual(expect.arrayContaining(["collection.filter", "collection.sort"]));
    expect(ATELIER_GRID_BUNDLE.routes.search.interactions.transitions.map((transition) => transition.action.type)).toEqual(expect.arrayContaining(["search.update", "search.submit", "search.clear"]));
  });

  it("derives closed data and capability plans from compiled route ownership", () => {
    for (const routeId of ROUTES) {
      const route = ATELIER_GRID_BUNDLE.routes[routeId];
      expect(route.requiredData.length).toBeGreaterThan(0);
      expect(route.requiredCapabilities).toContain("navigation");
    }
    expect(ATELIER_GRID_BUNDLE.routes.home.requiredData).toEqual(expect.arrayContaining([{ kind: "featuredProducts", limit: 12 }]));
    expect(ATELIER_GRID_BUNDLE.routes.collection.requiredData).toContainEqual({ kind: "currentCollection" });
    expect(ATELIER_GRID_BUNDLE.routes.product.requiredData).toContainEqual({ kind: "currentProduct" });
    expect(ATELIER_GRID_BUNDLE.routes.search.requiredData).toContainEqual({ kind: "searchResults", limit: 24 });
    expect(ATELIER_GRID_BUNDLE.routes.cart.requiredData).toContainEqual({ kind: "cart" });
  });
});
