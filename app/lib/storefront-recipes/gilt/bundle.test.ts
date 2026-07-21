import { describe, expect, it } from "vitest";
import { compileRecipeConfig } from "../factory";
import { GILT_RECIPE_CONFIG } from "./bundle";
import { GILT_ASSETS, GILT_ASSET_KEYS } from "./assets";
import type { CompiledNode } from "../../storefront-bundle/types";

function elements(nodes: readonly CompiledNode[]): Array<Extract<CompiledNode, { kind: "element" }>> {
  return nodes.flatMap((node) => node.kind === "text" ? [] : [node, ...elements(node.children)]);
}

describe("Gilt storefront recipe", () => {
  it("meets the Taste storefront hardening contract", () => {
    const surfaces = GILT_RECIPE_CONFIG.surfaces;
    const visibleCopy = Object.values(surfaces).map(({ source }) => source.html).join(" ");

    expect(surfaces.collections.source.html).toContain('data-cd-repeat="featured.collections"');
    expect(surfaces.collections.source.html).toContain('data-cd-key="collection.id"');
    expect(surfaces.collections.source.html).toContain('data-cd-param-handle="collection.handle"');
    expect(surfaces.collections.source.html).toContain('data-cd-text="collection.title"');
    expect(visibleCopy).not.toMatch(/[—–]|>0[1-4]<\/|404 \/|Live product •/);
    expect(surfaces.home.source.html.match(/class="gilt-hero-line"/g)).toHaveLength(2);
    expect(surfaces.home.source.css).toContain(".gilt-title{font-family:var(--font-display);font-size:clamp(3.2rem,8vw,6rem)");
    expect(surfaces.home.source.css).toContain("@media(max-width:760px)");
    expect(surfaces.home.source.css).toContain("@media(prefers-reduced-motion:reduce)");
    expect(surfaces.product.source.html).toContain('data-cd-slot="variantPicker"');
    expect(surfaces.product.source.html).toContain('data-cd-slot="addToCart"');
    expect(surfaces.cart.source.html).toContain('data-cd-route="collection"');
    expect(surfaces.home.source.css).toContain("white-space:nowrap");
  });

  it("compiles nine route-owned jewelry surfaces", () => {
    const { bundle, report } = compileRecipeConfig(GILT_RECIPE_CONFIG);
    expect(report).toMatchObject({ ok: true, diagnostics: [] });
    expect(Object.keys(bundle.routes)).toEqual(expect.arrayContaining([
      "home", "collections", "collection", "product", "search", "story", "cart", "checkout", "notFound",
    ]));
    expect(Object.keys(bundle.routes)).toHaveLength(9);
    expect(GILT_RECIPE_CONFIG.archetype).toMatchObject({
      composition: "object-ceremony", hero: "jewelry-ceremony-hero", scroll: "jewelry-orbit", cards: "object-vignettes",
    });
    expect(bundle.designSystem.tokens).toMatchObject({ cream: "#f8f0df", black: "#38271d", gold: "#c79421" });
  });

  it("keeps live variants, trusted gifting fields, and merchant policies beside purchase controls", () => {
    const { bundle } = compileRecipeConfig(GILT_RECIPE_CONFIG);
    const product = bundle.routes.product;
    expect(product.bindings.map(({ ref }) => ref)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "product.title" }),
      expect.objectContaining({ path: "product.price" }),
      expect.objectContaining({ path: "product.availability" }),
      expect.objectContaining({ path: "variant.title" }),
      expect.objectContaining({ path: "variant.price" }),
      expect.objectContaining({ path: "variant.availability" }),
    ]));
    expect(product.trustedSlots.map(({ kind }) => kind)).toEqual(expect.arrayContaining(["variantPicker", "addToCart"]));
    expect(product.trustedSlots.find(({ kind }) => kind === "addToCart")).toMatchObject({
      personalizationFields: ["engraving", "giftNote", "giftWrap", "recipient"],
    });
    expect(product.interactions.state).toEqual([]);
    expect(GILT_RECIPE_CONFIG.surfaces.product.source.html).not.toContain("data-cd-native-control");
    expect(product.html).not.toContain("data-cd-personalization");
    expect(product.requiredData.map(({ kind }) => kind)).toContain("policyLinks");
    expect(product.html).toContain("Review the merchant's current return and shipping terms");
    expect(product.html).toContain("Live product / current price / protected personalization");
    const addToCartId = product.trustedSlots.find(({ kind }) => kind === "addToCart")!.id;
    const purchaseColumn = elements(product.tree).find(({ attributes }) => attributes.class === "gilt-purchase")!;
    const purchaseNodes = elements(purchaseColumn.children);
    expect(purchaseNodes.some(({ trustedSlotId }) => trustedSlotId === addToCartId)).toBe(true);
    expect(purchaseNodes.findIndex(({ attributes }) => attributes.class === "gilt-proof")).toBeLessThan(
      purchaseNodes.findIndex(({ trustedSlotId }) => trustedSlotId === addToCartId),
    );
    expect(purchaseNodes.findIndex(({ attributes }) => attributes.class === "gilt-risk")).toBeLessThan(
      purchaseNodes.findIndex(({ trustedSlotId }) => trustedSlotId === addToCartId),
    );
  });

  it("deepens merchant-bound catalog discovery across Gilt routes", () => {
    const { bundle } = compileRecipeConfig(GILT_RECIPE_CONFIG);
    expect(GILT_RECIPE_CONFIG.surfaces.home.source.html).toContain('data-cd-route="collections"');
    expect(GILT_RECIPE_CONFIG.surfaces.home.source.html).toContain('data-cd-action="collection.filter"');
    expect(GILT_RECIPE_CONFIG.surfaces.collections.source.html.match(/data-cd-route="collection"/g)?.length).toBeGreaterThanOrEqual(1);
    expect(bundle.routes.collection.bindings.map(({ ref }) => ref)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "collection.productCount" }),
      expect.objectContaining({ path: "collection.image" }),
    ]));
    expect(bundle.routes.collection.interactions.transitions.map(({ action }) => action.type)).toEqual(
      expect.arrayContaining(["collection.filter", "collection.sort"]),
    );
    expect(GILT_RECIPE_CONFIG.surfaces.collection.source.html).toContain("Applied now");
    expect(bundle.routes.collection.trustedSlots.map(({ kind }) => kind)).toContain("quickViewCommerce");
    expect(bundle.routes.product.bindings.map(({ ref }) => ref)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "fact.label" }),
      expect.objectContaining({ path: "fact.value" }),
      expect.objectContaining({ path: "fact.url" }),
    ]));
    expect(GILT_RECIPE_CONFIG.surfaces.product.source.html).toContain("Related objects");
    expect(bundle.routes.search.html).toContain("results returned");
    expect(GILT_RECIPE_CONFIG.surfaces.search.source.html).toContain('data-cd-route="collections"');
    expect(bundle.routes.cart.bindings.map(({ ref }) => ref)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "cart.subtotal" }),
      expect.objectContaining({ path: "cartLine.unitPrice" }),
    ]));
    expect(bundle.routes.cart.trustedSlots.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(["cartLineControls", "cartSummary"]),
    );
  });

  it("uses merchant collection records for distinct collection paths", () => {
    const collections = GILT_RECIPE_CONFIG.surfaces.collections.source.html;
    expect(collections).toContain('data-cd-repeat="featured.collections"');
    expect(collections).toContain('data-cd-param-handle="collection.handle"');
    expect(collections).toContain('data-cd-route="collection"');
    expect(collections).not.toMatch(/Nine rooms|Collections of meaning/);
    expect(GILT_RECIPE_CONFIG.surfaces.checkout.source.html).not.toMatch(/engraving|recipient details|in the bag/i);
  });

  it("merchandises one or many live products without recipe-owned product claims", () => {
    const { bundle } = compileRecipeConfig(GILT_RECIPE_CONFIG);
    for (const routeId of ["home", "collection", "search"] as const) {
      const paths = bundle.routes[routeId].bindings.flatMap(({ ref }) => ref.kind === "data" ? [ref.path] : []);
      expect(paths, routeId).toEqual(expect.arrayContaining([
        "product.primaryImage",
        "product.title",
        "product.description",
        "product.price",
        "product.availability",
      ]));
    }
    expect(bundle.routes.home.requiredData.some(({ kind }) => kind === "featuredProducts")).toBe(true);
    expect(bundle.routes.collection.requiredData).toContainEqual({ kind: "currentCollection" });
    expect(bundle.routes.search.requiredData.some(({ kind }) => kind === "searchResults")).toBe(true);
    expect(GILT_RECIPE_CONFIG.surfaces.home.source.html).not.toMatch(/\b(?:necklace|ring|bracelet|earring)\b/i);
  });

  it("keeps gifting and delivery inside protected commerce", () => {
    const { bundle } = compileRecipeConfig(GILT_RECIPE_CONFIG);
    expect(GILT_RECIPE_CONFIG.surfaces.product.source.html).toContain(
      'data-cd-personalization="engraving giftNote giftWrap recipient"',
    );
    expect(bundle.routes.product.interactions.transitions.map(({ action }) => action.type)).not.toContain("cart.add");
    expect(bundle.shell.trustedSlots.map(({ kind }) => kind)).toContain("cartDrawer");
    expect(bundle.routes.cart.trustedSlots.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(["cartLineControls", "cartSummary"]),
    );
    expect(bundle.routes.checkout.layout.sectionOrder).toEqual(
      expect.arrayContaining(["contact", "shipping", "delivery", "payment", "summary"]),
    );
    expect(GILT_RECIPE_CONFIG.surfaces.product.source.html).toContain("destination is entered during secure checkout");
  });

  it("uses the runtime-supported availability facet", () => {
    expect(GILT_RECIPE_CONFIG.surfaces.collection.source.html).toContain('data-cd-facet="available"');
    expect(GILT_RECIPE_CONFIG.surfaces.collection.source.html).not.toContain('data-cd-facet="availability"');
  });

  it("keeps the object ceremony legible on wide and narrow storefronts", () => {
    const { bundle } = compileRecipeConfig(GILT_RECIPE_CONFIG);
    expect(bundle.shell.css).toMatch(/@media\s*\(max-width:760px\)/);
    expect(bundle.shell.css).toMatch(/\.gilt-shell nav a[^}]*min-height:44px/);
    expect(bundle.routes.home.css).toMatch(/position:sticky/);
    expect(bundle.routes.home.css).toMatch(/prefers-reduced-motion:reduce/);
    expect(bundle.routes.product.css).toMatch(/\.gilt-gallery\{[^}]*float:left[^}]*position:sticky/);
    expect(bundle.routes.product.css).toMatch(/\.gilt-purchase-copy\{[^}]*margin-left:55%/);
    expect(bundle.routes.product.css).toMatch(/@media\(max-width:760px\)\{[^}]*\.gilt-gallery[^}]*\}[^}]*\.gilt-purchase-copy\{[^}]*margin-left:0/);
  });

  it("requires one static ceremony hero without runtime video", () => {
    const { bundle, report } = compileRecipeConfig(GILT_RECIPE_CONFIG);
    expect(GILT_ASSET_KEYS).toEqual(["hero"]);
    expect(GILT_ASSETS.entries).toEqual([
      expect.objectContaining({ key: "hero", mediaType: "image/webp" }),
    ]);
    expect(GILT_ASSETS.entries[0]?.byteSize).toBeGreaterThan(0);
    expect(GILT_ASSETS.entries[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(bundle.routes.home.html).toMatch(/<img[^>]*class="gilt-hero-image"[^>]*data-cd-asset-key="hero"/);
    expect(Object.values(bundle.routes).flatMap((route) => "html" in route ? [route.html] : []).join(" ")).not.toContain("data-cd-video");
    expect(report.diagnostics.filter(({ code }) => code === "asset.reference_missing")).toEqual([]);
  });
});
