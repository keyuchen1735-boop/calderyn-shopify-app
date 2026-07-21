// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CompiledNode, RouteArtifact } from "~/lib/storefront-bundle/types";
import { renderStorefrontRoute, type PublicPresentationData } from "~/lib/storefront-runtime/render.server";
import { GLOW_ASSETS, GLOW_ASSET_KEYS } from "./assets";
import { GLOW_RECIPE, GLOW_RECIPE_CONFIG } from "./bundle";

function repeatsIn(nodes: readonly CompiledNode[]): string[] {
  return nodes.flatMap((node) => node.kind === "text"
    ? []
    : [...(node.repeat ? [node.repeat.source] : []), ...repeatsIn(node.children)]);
}

function dataPaths(route: RouteArtifact): string[] {
  return route.bindings.flatMap((binding) => binding.ref.kind === "data" ? [binding.ref.path] : []);
}

function productData(facts: NonNullable<NonNullable<PublicPresentationData["product"]>["facts"]>): PublicPresentationData {
  return {
    store: { name: "Glow Test", logo: null },
    policyLinks: [],
    product: {
      id: "product-1",
      handle: "product-one",
      title: "Product one",
      description: "Merchant-supplied directions and formula description.",
      primaryImage: null,
      images: [],
      options: [],
      variants: [{
        id: "variant-1",
        title: "Default",
        price: { cents: 2800, currency: "USD" },
        compareAtPrice: null,
        availability: "In stock",
        available: true,
      }],
      price: { cents: 2800, currency: "USD" },
      compareAtPrice: null,
      availability: "In stock",
      facts,
    },
    collection: null,
    featuredCollections: [],
    featuredProducts: [],
    relatedProducts: [],
    search: null,
    cart: null,
    notFound: null,
  };
}

describe("glow storefront recipe", () => {
  it("compiles nine high-key clinical routes around live merchant products", () => {
    const { bundle, report } = GLOW_RECIPE;

    expect(Object.keys(bundle.routes)).toEqual([
      "home", "collection", "product", "search", "cart", "checkout", "collections", "story", "notFound",
    ]);
    expect(bundle.source).toEqual({ kind: "recipe", templateId: "glow", templateVersion: 1 });
    expect(GLOW_RECIPE_CONFIG.archetype).toEqual({
      composition: "clinical-evidence",
      hero: "clinical-liquid-hero",
      scroll: "clinical-proof",
      cards: "evidence-cards",
      iconography: ["formula index marks", "quiet laboratory rules"],
    });
    expect(bundle.designSystem).toMatchObject({ displayFontId: "source-serif-4", bodyFontId: "atkinson-hyperlegible" });
    expect(repeatsIn(bundle.routes.home.tree)).toContain("featured.products");
    expect(repeatsIn(bundle.routes.collection.tree)).toContain("collection.products");
    expect(dataPaths(bundle.routes.product)).toEqual(expect.arrayContaining([
      "product.title", "product.description", "product.price", "product.availability",
      "fact.label", "fact.value", "fact.url", "variant.title", "variant.price", "variant.availability",
    ]));
    expect(report.ok).toBe(true);
    expect(report.diagnostics).toEqual([]);
  });

  it("uses preference-only guidance and a protected routine builder without making treatment claims", () => {
    const { bundle } = GLOW_RECIPE;

    expect(bundle.routes.home.interactions.state).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "enum", initial: "explore", allowedValues: ["explore", "simple", "layered", "all"] }),
    ]));
    expect(bundle.routes.home.trustedSlots).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "bundleBuilder", slotCount: 3, hostSize: "block" }),
    ]));
    expect(bundle.routes.home.html).toContain("including the same live product more than once");
    expect(bundle.routes.home.html).toContain("This guide does not assess your skin");
    expect(bundle.routes.product.trustedSlots.map(({ kind }) => kind)).toEqual(expect.arrayContaining(["variantPicker", "addToCart"]));
    expect(bundle.routes.cart.trustedSlots.map(({ kind }) => kind)).toEqual(expect.arrayContaining(["cartLineControls", "cartSummary"]));
    expect(bundle.shell.trustedSlots.map(({ kind }) => kind)).toContain("cartDrawer");

    const copy = Object.values(GLOW_RECIPE_CONFIG.surfaces).map(({ source }) => source.html).join(" ");
    expect(copy).not.toMatch(/before.?after|clinically proven|dermatologist|\bcures?\b|\bheals?\b|diagnos|limited stock|selling fast|auto.?replenish|customer reviews?|\d+ reviews?|review stars?/i);
    expect(copy).toContain("when this merchant offers them");
  });

  it("keeps protected purchase controls with live facts and renders only merchant-supplied evidence", () => {
    const source = document.createElement("div");
    source.innerHTML = GLOW_RECIPE_CONFIG.surfaces.product.source.html;
    const purchase = source.querySelector(".glow-purchase");
    expect(purchase?.querySelector('[data-cd-slot="variantPicker"]')).not.toBeNull();
    expect(purchase?.querySelector('[data-cd-slot="addToCart"]')).not.toBeNull();
    expect(purchase?.querySelector('.glow-facts [data-cd-empty-state]')).toBeNull();

    const evidenceHtml = renderToStaticMarkup(renderStorefrontRoute({
      routeId: "product",
      artifact: GLOW_RECIPE.bundle.routes.product,
      data: productData([{
        id: "fact-1",
        kind: "ingredient",
        label: "Featured ingredient",
        value: "Merchant formula record",
        unit: null,
        url: "https://merchant.example/formula",
      }]),
      nonce: "glow-test",
    }).element);
    expect(evidenceHtml).toContain("Featured ingredient");
    expect(evidenceHtml).toContain("Merchant formula record");
    expect(evidenceHtml).toContain('href="https://merchant.example/formula"');
  });

  it("deepens catalog discovery with bounded commerce controls across collection, product, search, cart, and checkout", () => {
    const { bundle } = GLOW_RECIPE;

    expect(GLOW_RECIPE_CONFIG.surfaces.home.source.html).toContain('data-cd-route="collections"');
    expect(GLOW_RECIPE_CONFIG.surfaces.home.source.html).toContain('data-cd-route="search"');
    expect(bundle.routes.collections?.html).toContain('glow-directory-card');
    expect(GLOW_RECIPE_CONFIG.surfaces.collections.source.html).toContain('data-cd-repeat="featured.products"');

    expect(bundle.routes.collection.html).toContain('aria-label="Formula breadcrumbs"');
    expect(bundle.routes.collection.html).toContain('aria-label="Sibling formula shelves"');
    expect(bundle.routes.collection.html).toContain('glow-applied');
    expect(GLOW_RECIPE_CONFIG.surfaces.collection.source.html).toContain('data-cd-action="collection.filter"');
    expect(GLOW_RECIPE_CONFIG.surfaces.collection.source.html).toContain('data-cd-action="collection.sort"');
    expect(GLOW_RECIPE_CONFIG.surfaces.collection.source.html).toContain('data-cd-slot="quickViewCommerce"');
    expect(dataPaths(bundle.routes.collection)).toEqual(expect.arrayContaining([
      "collection.title", "collection.description", "collection.productCount",
      "product.title", "product.description", "product.price", "product.availability",
    ]));

    expect(bundle.routes.product.html).toContain('glow-gallery');
    expect(bundle.routes.product.html).toContain('glow-reassurance');
    expect(GLOW_RECIPE_CONFIG.surfaces.product.source.html).toContain('data-cd-repeat="related.products"');
    expect(bundle.routes.product.trustedSlots.map(({ kind }) => kind)).toEqual(expect.arrayContaining(["variantPicker", "addToCart"]));

    expect(bundle.routes.search.html).toContain('Result count updates');
    expect(GLOW_RECIPE_CONFIG.surfaces.search.source.html).toContain('data-cd-route="collections"');
    expect(bundle.routes.cart.html).toContain('glow-cart-reassurance');
    expect(bundle.routes.checkout.decorativeHtml).toContain('glow-checkout-path');
  });

  it("requires one generated hero image, ships no runtime video, and keeps thumb-safe navigation", () => {
    expect(GLOW_ASSET_KEYS).toEqual(["hero"]);
    expect(GLOW_ASSETS.entries).toEqual([
      expect.objectContaining({ key: "hero", contentHash: expect.stringMatching(/^[a-f0-9]{64}$/), mediaType: "image/webp" }),
    ]);
    expect(GLOW_ASSETS.entries[0]?.byteSize).toBeGreaterThan(0);
    expect(GLOW_RECIPE.bundle.routes.home.html).toContain('class="glow-hero-image" data-cd-asset-key="hero"');
    expect(Object.values(GLOW_RECIPE.bundle.routes).map((route) => "html" in route ? route.html : route.decorativeHtml).join(" ")).not.toContain("data-cd-video");
    expect(GLOW_RECIPE_CONFIG.surfaces.shell.source.css).toContain(".glow-mark{display:flex;align-items:center;min-height:44px");
    expect(GLOW_RECIPE_CONFIG.surfaces.shell.source.css).toContain(".glow-footer a{display:inline-flex;align-items:center;min-height:44px");
    expect(GLOW_RECIPE_CONFIG.surfaces.product.source.css).toContain(".glow-fact a,.glow-product-copy nav a{display:inline-flex;align-items:center;min-height:44px");
    expect(GLOW_RECIPE_CONFIG.surfaces.story.source.css).toContain(".glow-story-policy a{display:inline-flex;align-items:center;min-height:44px");
    expect(GLOW_RECIPE_CONFIG.surfaces.checkout.source.css).toContain(".glow-checkout-policy a{display:inline-flex;align-items:center;min-height:44px");
    expect(GLOW_RECIPE_CONFIG.surfaces.notFound.source.css).toContain(".glow-lost nav a{display:inline-flex;align-items:center;min-height:44px");
    expect(GLOW_RECIPE.bundle.routes.home.css).toContain("prefers-reduced-motion:reduce");
  });

  it("uses live collection shelves, one accent, visible hero CTA, and empty-bag recovery", () => {
    const { bundle } = GLOW_RECIPE;
    const surfaces = GLOW_RECIPE_CONFIG.surfaces;
    const collections = surfaces.collections.source.html;
    const routeHtml = Object.values(surfaces).map(({ source }) => source.html).join(" ");
    const prototype = readFileSync(resolve(process.cwd(), "docs/superpowers/prototypes/storefront-recipes/glow.html"), "utf8");

    expect(collections).toContain('data-cd-repeat="featured.collections"');
    expect(collections).toContain('data-cd-key="collection.id"');
    expect(collections).toContain('data-cd-param-handle="collection.handle"');
    expect(collections).toContain('data-cd-text="collection.title"');
    expect(routeHtml).not.toMatch(/[—–]/);
    expect(routeHtml).not.toMatch(/>0[1-9]</);
    expect(surfaces.home.source.css).toContain("clamp(3.5rem,6vw,6rem)");
    expect(surfaces.home.source.css).toContain(".glow-hero-actions .glow-button{color:var(--porcelain)}");
    expect(surfaces.home.source.css).toContain(".glow-routine{background:var(--serum)}");
    expect(surfaces.home.source.css).not.toContain("var(--blush)");
    expect(surfaces.home.source.html).not.toContain("glow-proof");
    expect(surfaces.home.source.css).not.toContain("glow-proof");
    expect(surfaces.cart.source.html).toContain('data-cd-route="collections"');
    expect(bundle.routes.product.trustedSlots.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(["variantPicker", "addToCart"]),
    );
    expect(prototype).toContain("clamp(3.5rem,6vw,6rem)");
    expect(prototype).toContain(".glow-hero-actions .glow-button{color:var(--porcelain)}");
    expect(prototype).not.toContain("glow-proof");
    expect(prototype).not.toMatch(/[—–]/);
  });
});
