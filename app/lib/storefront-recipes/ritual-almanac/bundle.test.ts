import { describe, expect, it } from "vitest";
import type { CompiledNode, RouteArtifact } from "~/lib/storefront-bundle/types";
import { RITUAL_ALMANAC_ASSETS } from "./assets";
import { RITUAL_ALMANAC_RECIPE } from "./bundle";

const repeats = (nodes: readonly CompiledNode[]): string[] => nodes.flatMap((node) => node.kind === "text" ? [] : [...(node.repeat ? [node.repeat.source] : []), ...repeats(node.children)]);
const actions = (route: RouteArtifact) => route.interactions.transitions.map((item) => item.action.type);

describe("ritual-almanac storefront recipe", () => {
  it("keeps the original arched hero seal and five-part day wheel", () => {
    expect(RITUAL_ALMANAC_RECIPE.bundle.routes.home.html).toContain("A pantry for every hour");
    expect(RITUAL_ALMANAC_RECIPE.bundle.routes.home.html).toContain(">Move</button>");
  });

  it("renders provision imagery and availability in almanac search results", () => {
    const paths = RITUAL_ALMANAC_RECIPE.bundle.routes.search.bindings.map((binding) => binding.ref.kind === "data" ? binding.ref.path : null);
    expect(paths).toEqual(expect.arrayContaining(["product.primaryImage", "product.title", "product.description", "product.price", "product.availability"]));
  });

  it("keeps the live pantry in the approved responsive product grid", () => {
    const css = RITUAL_ALMANAC_RECIPE.config.surfaces.collection.source.css;
    expect(css).toContain(".productGrid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}");
    expect(css).toContain(".collection{display:block}");
    expect(css).toContain(".productGrid{grid-template-columns:1fr 1fr}");
  });

  it("compiles editorial ritual chapters, cadence selection, and every commerce surface", () => {
    const { bundle, config, report } = RITUAL_ALMANAC_RECIPE;
    expect(report).toMatchObject({ profileVersion: 1, ok: true, diagnostics: [] });
    expect(bundle.source).toEqual({ kind: "recipe", templateId: "ritual-almanac", templateVersion: 6 });
    expect(config.archetype).toEqual({ composition: "editorial-almanac", hero: "ritual-time-hero", scroll: "almanac-chapters", cards: "ritual-entries", iconography: ["time ritual marks", "flavor note symbols"] });
    expect(bundle.designSystem).toMatchObject({ displayFontId: "young-serif", bodyFontId: "manrope", iconStyle: "time-of-day marks and restrained flavor-note symbols", motionStyle: "chapter reveals with ritual-time tab transitions" });
    expect(new Set(Object.values(config.surfaces).map((surface) => surface.signature)).size).toBe(7);
    expect(RITUAL_ALMANAC_ASSETS.entries).toEqual([expect.objectContaining({ key: "hero", byteSize: 303882 })]);
    expect(bundle.routes.home.html).toContain('data-cd-asset-key="hero"');
    expect(bundle.routes.home.html).toContain("Wake");
    expect(bundle.routes.home.html).toContain("Unwind");
    expect(actions(bundle.routes.home)).toEqual(expect.arrayContaining(["tabs.select"]));
    expect(bundle.shell.trustedSlots.map((slot) => slot.kind)).toContain("cartDrawer");
    expect(repeats(bundle.routes.collection.tree)).toContain("collection.products");
    expect(actions(bundle.routes.collection)).toEqual(expect.arrayContaining(["collection.filter", "collection.sort"]));
    expect(bundle.routes.collection.trustedSlots.map((slot) => slot.kind)).toContain("quickViewCommerce");
    expect(repeats(bundle.routes.product.tree)).toEqual(expect.arrayContaining(["product.images", "product.variants"]));
    expect(bundle.routes.product.trustedSlots.map((slot) => slot.kind)).toEqual(expect.arrayContaining(["variantPicker", "addToCart"]));
    expect(repeats(bundle.routes.search.tree)).toContain("search.results");
    expect(actions(bundle.routes.search)).toEqual(expect.arrayContaining(["search.submit", "search.clear"]));
    expect(repeats(bundle.routes.cart.tree)).toContain("cart.lines");
    expect(bundle.routes.cart.trustedSlots.map((slot) => slot.kind)).toEqual(expect.arrayContaining(["cartLineControls", "cartSummary"]));
    expect(bundle.routes.checkout.layout).toMatchObject({ columnMode: "summaryAside", spacingTokenId: "chapter-space" });
    const text = Object.values(bundle.routes).map((route) => "html" in route ? route.html : route.decorativeHtml).join(" ");
    expect(text).toContain("No provisions match this ritual");
    expect(text).toContain("Sold out");
    expect(text).toContain("Subscription cadence");
    expect(text).not.toMatch(/https?:\/\//);
    expect(Object.values(bundle.routes).filter((route): route is RouteArtifact => "html" in route).every((route) => route.css.includes("overflow-wrap:anywhere"))).toBe(true);
  });
});
