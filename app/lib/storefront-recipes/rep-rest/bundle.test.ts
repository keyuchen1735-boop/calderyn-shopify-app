import { describe, expect, it } from "vitest";
import type { CompiledNode, RouteArtifact } from "~/lib/storefront-bundle/types";
import { REP_REST_ASSETS } from "./assets";
import { REP_REST_RECIPE } from "./bundle";

const repeats = (nodes: readonly CompiledNode[]): string[] => nodes.flatMap((node) => node.kind === "text" ? [] : [...(node.repeat ? [node.repeat.source] : []), ...repeats(node.children)]);
const actions = (route: RouteArtifact): string[] => route.interactions.transitions.map((item) => item.action.type);

describe("rep-rest storefront recipe", () => {
  it("keeps the original movement ticker between the split hero and work set", () => {
    expect(REP_REST_RECIPE.bundle.routes.home.html).toContain("Mobility · Strength · Endurance · Recovery");
  });

  it("renders live product imagery and availability in search results", () => {
    const paths = REP_REST_RECIPE.bundle.routes.search.bindings.map((binding) => binding.ref.kind === "data" ? binding.ref.path : null);
    expect(paths).toEqual(expect.arrayContaining(["product.primaryImage", "product.title", "product.description", "product.price", "product.availability"]));
  });

  it("compiles a split training and recovery journey with complete commerce contracts", () => {
    const { bundle, config, report } = REP_REST_RECIPE;
    expect(report).toMatchObject({ profileVersion: 1, ok: true, diagnostics: [] });
    expect(bundle.source).toEqual({ kind: "recipe", templateId: "rep-rest", templateVersion: 4 });
    expect(config.archetype).toEqual({ composition: "split-performance", hero: "training-recovery-split", scroll: "sticky-workout", cards: "comparison-rails", iconography: ["training interval marks", "recovery status glyphs"] });
    expect(bundle.designSystem).toMatchObject({ displayFontId: "archivo-narrow", bodyFontId: "inter", iconStyle: "interval arrows and recovery-state glyphs", motionStyle: "sticky workout chapters with kinetic split transitions" });
    expect(new Set(Object.values(config.surfaces).map((surface) => surface.signature)).size).toBe(7);
    expect(REP_REST_ASSETS.entries).toEqual([expect.objectContaining({ key: "hero", mediaType: "image/webp", byteSize: 122192 })]);
    expect(bundle.routes.home.html).toContain('data-cd-asset-key="hero"');
    expect(bundle.routes.home.html).toContain("Training");
    expect(bundle.routes.home.html).toContain("Recovery");
    expect(bundle.shell.trustedSlots.map((slot) => slot.kind)).toContain("cartDrawer");
    expect(repeats(bundle.routes.home.tree)).toContain("featured.products");
    expect(repeats(bundle.routes.collection.tree)).toContain("collection.products");
    expect(actions(bundle.routes.collection)).toEqual(expect.arrayContaining(["collection.filter", "collection.sort", "collection.view"]));
    expect(bundle.routes.collection.trustedSlots.map((slot) => slot.kind)).toContain("quickViewCommerce");
    expect(repeats(bundle.routes.product.tree)).toEqual(expect.arrayContaining(["product.images", "product.variants"]));
    expect(bundle.routes.product.trustedSlots.map((slot) => slot.kind)).toEqual(expect.arrayContaining(["variantPicker", "addToCart"]));
    expect(repeats(bundle.routes.search.tree)).toContain("search.results");
    expect(actions(bundle.routes.search)).toEqual(expect.arrayContaining(["search.submit", "search.clear"]));
    expect(repeats(bundle.routes.cart.tree)).toContain("cart.lines");
    expect(bundle.routes.cart.trustedSlots.map((slot) => slot.kind)).toEqual(expect.arrayContaining(["cartLineControls", "cartSummary"]));
    expect(bundle.routes.checkout.layout).toMatchObject({ columnMode: "summaryFirst", spacingTokenId: "interval" });
    const text = Object.values(bundle.routes).map((route) => "html" in route ? route.html : route.decorativeHtml).join(" ");
    expect(text).toContain("No gear matches this training state");
    expect(text).toContain("Sold out");
    expect(text).not.toMatch(/https?:\/\//);
    expect(Object.values(bundle.routes).filter((route): route is RouteArtifact => "html" in route).every((route) => route.css.includes("overflow-wrap:anywhere"))).toBe(true);
  });
});
