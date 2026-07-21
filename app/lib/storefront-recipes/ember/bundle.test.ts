import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { CompiledNode, RouteArtifact } from "~/lib/storefront-bundle/types";
import { compileRecipeConfig } from "../factory";
import { EMBER_ASSETS, EMBER_STATIC_ASSET_KEYS } from "./assets";
import { EMBER_RECIPE_CONFIG } from "./bundle";

function repeatsIn(nodes: readonly CompiledNode[]): string[] {
  return nodes.flatMap((node) => node.kind === "text"
    ? []
    : [...(node.repeat ? [node.repeat.source] : []), ...repeatsIn(node.children)]);
}

function dataPaths(route: RouteArtifact): string[] {
  return route.bindings.flatMap((binding) => binding.ref.kind === "data" ? [binding.ref.path] : []);
}

function elements(nodes: readonly CompiledNode[]): Array<Extract<CompiledNode, { kind: "element" }>> {
  return nodes.flatMap((node) => node.kind === "text" ? [] : [node, ...elements(node.children)]);
}

function contrastRatio(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    const channels = hex.slice(1).match(/.{2}/g)!.map((value) => Number.parseInt(value, 16) / 255);
    const [red, green, blue] = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
  };
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
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
    expect(contrastRatio(
      EMBER_RECIPE_CONFIG.designSystem.tokens.bone,
      EMBER_RECIPE_CONFIG.designSystem.tokens.pepper,
    )).toBeGreaterThanOrEqual(4.5);
    expect(EMBER_RECIPE_CONFIG.surfaces.shell.source.css).toMatch(
      /@media\(max-width:720px\)[^{]*\{[^}]*\.ember-mark[^}]*min-height:44px/s,
    );
    expect(EMBER_RECIPE_CONFIG.surfaces.shell.source.css).toMatch(
      /@media\(max-width:720px\)[^{]*\{[^}]*\.ember-masthead>div a[^}]*min-height:44px/s,
    );

    expect(repeatsIn(bundle.routes.home.tree)).toContain("featured.products");
    expect(repeatsIn(bundle.routes.collection.tree)).toContain("collection.products");
    expect(dataPaths(bundle.routes.collection)).toEqual(expect.arrayContaining([
      "collection.title", "collection.description", "product.title", "product.description", "product.price", "product.availability",
    ]));
    expect(dataPaths(bundle.routes.product)).toEqual(expect.arrayContaining([
      "product.title", "product.description", "product.price", "product.availability",
      "fact.label", "fact.value", "fact.url", "variant.title", "variant.price",
    ]));
    expect(repeatsIn(bundle.routes.product.tree)).toContain("product.facts");

    const filters = bundle.routes.collection.interactions.transitions
      .filter(({ action }) => action.type === "collection.filter")
      .map(({ action }) => action.type === "collection.filter" ? action.facetId : "");
    expect(filters).toEqual(["tag", "tag", "tag", "tag", "tag"]);
    expect(EMBER_RECIPE_CONFIG.surfaces.collection.source.html).toContain("merchant-supplied heat tags");

    const homeHtml = bundle.routes.home.html;
    expect(homeHtml).toContain("Build a tasting flight");
    expect(homeHtml).toContain("ember-flight");
    expect(bundle.routes.home.trustedSlots).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "bundleBuilder", slotCount: 3, hostSize: "block" }),
    ]));
    const homeNodes = elements(bundle.routes.home.tree);
    const builderId = bundle.routes.home.trustedSlots[0]!.id;
    expect(homeNodes.findIndex(({ attributes }) => attributes.class === "ember-flight-intro")).toBeLessThan(
      homeNodes.findIndex(({ trustedSlotId }) => trustedSlotId === builderId),
    );
    expect(homeNodes.findIndex(({ trustedSlotId }) => trustedSlotId === builderId)).toBeLessThan(
      homeNodes.findIndex(({ attributes }) => attributes.class === "ember-flight-catalog"),
    );
    expect(homeHtml).toContain("including the same product more than once");
    expect(bundle.routes.home.interactions.state).toEqual([]);
    expect(homeHtml).not.toContain("ember-ugc");
    expect(homeHtml).not.toMatch(/★★★★★|“[^”]+”|verified buyer/i);

    expect(EMBER_RECIPE_CONFIG.surfaces.product.source.html).toContain('data-cd-text="product.availability"');
    expect(elements(bundle.routes.product.tree).some(({ tag }) => tag === "main")).toBe(true);
    expect(bundle.routes.product.trustedSlots.map(({ kind }) => kind)).toEqual(expect.arrayContaining(["variantPicker", "addToCart"]));
    const purchaseColumn = elements(bundle.routes.product.tree).find(({ attributes }) => attributes.class === "ember-purchase")!;
    const purchaseNodes = elements(purchaseColumn.children);
    for (const kind of ["variantPicker", "addToCart"] as const) {
      const slotId = bundle.routes.product.trustedSlots.find((slot) => slot.kind === kind)!.id;
      expect(purchaseNodes.some(({ trustedSlotId }) => trustedSlotId === slotId), kind).toBe(true);
    }
    expect(bundle.routes.product.html).not.toMatch(/only \d+|selling fast|ships (?:today|tomorrow)|low stock/i);
    expect(bundle.routes.cart.trustedSlots.map(({ kind }) => kind)).toEqual(expect.arrayContaining(["cartLineControls", "cartSummary"]));

    expect(report).toMatchObject({ ok: true, diagnostics: [] });
    expect(EMBER_STATIC_ASSET_KEYS).toEqual(["hero"]);
    expect(EMBER_ASSETS.entries).toEqual([
      expect.objectContaining({
        key: "hero",
        mediaType: "image/webp",
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    expect(EMBER_ASSETS.entries[0]!.byteSize).toBeGreaterThan(0);
    expect(homeHtml).toContain('data-cd-asset-key="hero"');
    expect(Object.values(bundle.routes).map((route) => "html" in route ? route.html : route.decorativeHtml).join(" ")).not.toContain("<video");
    expect(bundle.routes.home.css).toContain("@media(max-width:720px)");
    expect(bundle.routes.home.css).toContain("min-height:44px");
    expect(bundle.routes.home.css).toContain("prefers-reduced-motion:reduce");
  });

  it("deepens Ember catalog discovery without crossing commerce truth boundaries", () => {
    const { bundle } = compileRecipeConfig(EMBER_RECIPE_CONFIG);

    expect(bundle.routes.home.html).toContain("ember-collection-hooks");
    expect(bundle.routes.collections?.html).toContain("ember-shelf-index");
    expect(bundle.routes.collections?.html).toContain("data-cd-bind-text");
    expect(bundle.routes.collection.html).toContain("ember-breadcrumbs");
    expect(bundle.routes.collection.html).toContain("ember-sibling-nav");
    expect(bundle.routes.collection.html).toContain("ember-applied-filters");
    expect(bundle.routes.collection.html).toContain("data-cd-bind-text");
    expect(bundle.routes.collection.interactions.transitions.map(({ action }) => action.type)).toContain("collection.sort");
    expect(bundle.routes.collection.trustedSlots.map(({ kind }) => kind)).toContain("quickViewCommerce");
    expect(repeatsIn(bundle.routes.product.tree)).toContain("related.products");
    expect(bundle.routes.product.html).toContain("ember-policy-reassurance");
    expect(bundle.routes.product.trustedSlots.map(({ kind }) => kind)).toEqual(expect.arrayContaining(["variantPicker", "addToCart"]));
    expect(bundle.routes.search.html).toContain("ember-search-count");
    expect(bundle.routes.search.html).toContain("Browse sauce shelves");
    expect(bundle.routes.cart.html).toContain("ember-cart-progress");
    expect(bundle.routes.cart.html).toContain("Policy links below reflect the merchant's current store terms.");
    expect(bundle.routes.checkout.decorativeHtml).toContain("Products, delivery, payment, and final totals remain controlled by the platform.");
    expect(Object.values(bundle.routes).map((route) => "html" in route ? route.html : route.decorativeHtml).join(" ")).not.toMatch(/verified buyer|★★★★★|scarcity|discount|ships today|ships tomorrow|clinical|performance/i);
  });

  it("ships the recipe-owned static asset contract and visual prototype", () => {
    for (const path of [
      "app/lib/storefront-recipes/ember/assets.ts",
      "docs/superpowers/prototypes/storefront-recipes/ember.html",
    ]) {
      expect(existsSync(resolve(process.cwd(), path)), path).toBe(true);
    }
  });
});
