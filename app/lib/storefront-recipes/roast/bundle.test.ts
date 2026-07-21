import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { CompiledNode, RouteArtifact } from "~/lib/storefront-bundle/types";
import { compileRecipeConfig } from "../factory";
import { ROAST_ASSETS, ROAST_STATIC_ASSET_KEYS } from "./assets";
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
      "fact.label", "fact.value", "fact.url",
    ]));
    expect(repeatsIn(bundle.routes.product.tree)).toEqual(expect.arrayContaining(["product.variants", "product.facts"]));
    expect(ROAST_RECIPE_CONFIG.surfaces.product.source.html).toContain("Merchant product record");
    expect(ROAST_RECIPE_CONFIG.surfaces.product.source.html).toContain('data-cd-href="fact.url"');

    expect(bundle.routes.home.interactions.transitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: expect.objectContaining({ type: "tabs.select" }) }),
    ]));
    expect(ROAST_RECIPE_CONFIG.surfaces.home.source.html).toContain("Brew-method field guide");
    expect(ROAST_RECIPE_CONFIG.surfaces.home.source.html).toContain('data-cd-target="brew-guide"');
    expect(ROAST_RECIPE_CONFIG.surfaces.home.source.html).toContain("This guide does not claim a catalog match");
    expect(ROAST_RECIPE_CONFIG.surfaces.home.source.html).toContain('data-cd-route="collection"');

    expect(ROAST_RECIPE_CONFIG.surfaces.product.source.html).toContain("If grind is an available merchant option");
    expect(ROAST_RECIPE_CONFIG.surfaces.product.source.html).toContain("Recurring delivery appears only when the merchant offers it");
    expect(bundle.routes.product.trustedSlots.map(({ kind }) => kind)).toEqual(expect.arrayContaining(["variantPicker", "addToCart"]));
    expect(ROAST_RECIPE_CONFIG.surfaces.product.source.html).not.toContain('name="grind"');
    expect(ROAST_RECIPE_CONFIG.surfaces.product.source.html).not.toContain('data-cd-action="sellingPlan.select"');
    expect(bundle.routes.product.html).not.toMatch(/always available|guaranteed freshness|roasted today|ships today/i);

    expect(repeatsIn(bundle.routes.cart.tree)).toContain("cart.lines");
    expect(bundle.routes.cart.trustedSlots.map(({ kind }) => kind)).toEqual(expect.arrayContaining(["cartLineControls", "cartSummary"]));
    expect(bundle.routes.cart.html).toContain("Selected product options remain on their cart lines");
    expect(bundle.routes.checkout.decorativeHtml).toContain("Selected product options remain attached to each line");

    const customerCopy = Object.values(ROAST_RECIPE_CONFIG.surfaces)
      .map(({ source }) => source.html)
      .join(" ");
    expect(customerCopy).not.toMatch(/matched for you|recommended coffee|best coffee for|guaranteed match/i);

    expect(report).toMatchObject({ ok: true, diagnostics: [] });
    expect(ROAST_STATIC_ASSET_KEYS).toEqual(["hero"]);
    expect(ROAST_ASSETS.entries).toEqual([
      expect.objectContaining({
        key: "hero",
        mediaType: "image/webp",
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    expect(ROAST_ASSETS.entries[0]!.byteSize).toBeGreaterThan(0);
    expect(bundle.routes.home.html).toContain('data-cd-asset-key="hero"');
    expect(Object.values(bundle.routes).map((route) => "html" in route ? route.html : route.decorativeHtml).join(" ")).not.toContain("<video");
    expect(bundle.routes.home.css).toContain("prefers-reduced-motion:reduce");
  });


  it("covers the Baymard-depth merchant-bound catalog contract", () => {
    const { bundle } = compileRecipeConfig(ROAST_RECIPE_CONFIG);
    const home = ROAST_RECIPE_CONFIG.surfaces.home.source.html;
    const collections = ROAST_RECIPE_CONFIG.surfaces.collections.source.html;
    const collection = ROAST_RECIPE_CONFIG.surfaces.collection.source.html;
    const product = ROAST_RECIPE_CONFIG.surfaces.product.source.html;
    const search = ROAST_RECIPE_CONFIG.surfaces.search.source.html;
    const cart = ROAST_RECIPE_CONFIG.surfaces.cart.source.html;

    expect(home.match(/data-cd-route="collection"/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(collections).toContain("Method notebooks");
    expect(collections.match(/data-cd-route="collection"/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(collections).toContain('data-cd-repeat="featured.products"');

    expect(collection).toContain("Origin index / merchant record");
    expect(collection).toContain("Sibling notebooks");
    expect(collection).toContain('data-cd-text="collection.productCount"');
    expect(collection).toContain('data-cd-action="collection.filter"');
    expect(collection).toContain('data-cd-action="collection.sort"');
    expect(collection).toContain("Applied filter");
    expect(collection).toContain('data-cd-slot="quickViewCommerce"');
    expect(dataPaths(bundle.routes.collection)).toEqual(expect.arrayContaining([
      "collection.title", "collection.description", "collection.productCount", "product.primaryImage", "product.title",
      "product.description", "product.price", "product.availability",
    ]));

    expect(product).toContain('data-cd-repeat="product.images"');
    expect(product).toContain('data-cd-repeat="product.facts"');
    expect(product).toContain("Policy and checkout notes");
    expect(product).toContain('data-cd-repeat="related.products"');
    expect(repeatsIn(bundle.routes.product.tree)).toContain("related.products");
    expect(bundle.routes.product.trustedSlots.map(({ kind }) => kind)).toEqual(expect.arrayContaining(["variantPicker", "addToCart"]));

    expect(search).toContain('data-cd-repeat="search.results"');
    expect(search).toContain("Result count");
    expect(search).toContain("Browse method notebooks");
    expect(search).toContain("No coffee matches that search");

    expect(cart).toContain('data-cd-slot="cartLineControls"');
    expect(cart).toContain('data-cd-slot="cartSummary"');
    expect(cart).toContain("Checkout stays protected");
    expect(ROAST_RECIPE_CONFIG.surfaces.checkout.source.html).toContain("platform controlled");
  });

  it("ships the recipe-owned static asset contract and visual prototype", () => {
    for (const path of [
      "app/lib/storefront-recipes/roast/assets.ts",
      "docs/superpowers/prototypes/storefront-recipes/roast.html",
    ]) {
      expect(existsSync(resolve(process.cwd(), path)), path).toBe(true);
    }

    const prototype = readFileSync(resolve(
      process.cwd(),
      "docs/superpowers/prototypes/storefront-recipes/roast.html",
    ), "utf8");
    expect(prototype).toContain("Brew-method field guide");
    expect(prototype.match(/data-cd-action="tabs.select"/g)).toHaveLength(3);
    expect(prototype).toContain("This guide does not claim a catalog match");
    expect(prototype).toContain('class="roast-hero-image" data-cd-asset-key="hero"');
    expect(prototype).not.toContain("<video");
    expect(prototype).not.toMatch(/matched for you|recommended coffee|best coffee for|guaranteed match/i);
  });
});
