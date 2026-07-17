import { describe, expect, it } from "vitest";
import type { CompiledNode, RouteArtifact } from "~/lib/storefront-bundle/types";
import { proveStorefrontBundle } from "~/lib/storefront-validation/browser.server";
import { storefrontProofContext } from "~/lib/storefront-validation/fixtures";
import { DIAGNOSTIC_DECK_ASSETS } from "./assets";
import { DIAGNOSTIC_DECK_BUNDLE, DIAGNOSTIC_DECK_RECIPE } from "./bundle";

const repeats = (nodes: readonly CompiledNode[]): string[] => nodes.flatMap((node) => node.kind === "text" ? [] : [...(node.repeat ? [node.repeat.source] : []), ...repeats(node.children)]);
const actions = (route: RouteArtifact) => route.interactions.transitions.map((item) => item.action.type);

describe("diagnostic-deck storefront recipe", () => {
  it("renders for an empty merchant catalog", async () => {
    const [empty, populated] = await Promise.all([
      proveStorefrontBundle({
        bundle: DIAGNOSTIC_DECK_BUNDLE,
        context: storefrontProofContext(0),
        routes: ["home", "collection", "search"],
        viewports: ["mobile"],
      }),
      proveStorefrontBundle({
        bundle: DIAGNOSTIC_DECK_BUNDLE,
        context: storefrontProofContext(),
        routes: ["collection"],
        viewports: ["mobile"],
      }),
    ]);
    expect(empty).toMatchObject({ ok: true, diagnostics: [] });
    expect(populated).toMatchObject({ ok: true, diagnostics: [] });
  }, 60_000);

  it("compiles a diagnostic terminal deck with exact-unit evidence and complete transactions", () => {
    const { bundle, config, report } = DIAGNOSTIC_DECK_RECIPE;
    expect(report).toMatchObject({ profileVersion: 1, ok: true, diagnostics: [] });
    expect(bundle.source).toEqual({ kind: "recipe", templateId: "diagnostic-deck", templateVersion: 1 });
    expect(config.archetype).toEqual({ composition: "diagnostic-terminal", hero: "grade-diagnostic-hero", scroll: "deck-snap", cards: "diagnostic-cards", iconography: ["terminal condition marks", "warranty status glyphs"] });
    expect(bundle.designSystem).toMatchObject({ displayFontId: "archivo-narrow", bodyFontId: "ibm-plex-mono", iconStyle: "terminal condition marks and warranty-status glyphs", motionStyle: "deck snap with evidence-panel expansion" });
    expect(new Set(Object.values(config.surfaces).map((surface) => surface.signature)).size).toBe(7);
    expect(DIAGNOSTIC_DECK_ASSETS.entries).toEqual([expect.objectContaining({ key: "hero", byteSize: 101094 })]);
    expect(bundle.routes.home.html).toContain('data-cd-asset-key="hero"');
    expect(bundle.routes.home.html).toContain("Known condition");
    expect(bundle.routes.home.html).toContain("Warranty evidence");
    expect(bundle.shell.trustedSlots.map((slot) => slot.kind)).toContain("cartDrawer");
    expect(repeats(bundle.routes.collection.tree)).toContain("collection.products");
    expect(actions(bundle.routes.collection)).toEqual(expect.arrayContaining(["collection.filter", "collection.sort"]));
    expect(bundle.routes.collection.html).toContain("<details");
    expect(bundle.routes.collection.trustedSlots.map((slot) => slot.kind)).toContain("quickViewCommerce");
    expect(repeats(bundle.routes.product.tree)).toEqual(expect.arrayContaining(["product.images", "product.variants"]));
    expect(bundle.routes.product.trustedSlots.map((slot) => slot.kind)).toEqual(expect.arrayContaining(["variantPicker", "addToCart"]));
    expect(repeats(bundle.routes.search.tree)).toContain("search.results");
    expect(actions(bundle.routes.search)).toEqual(expect.arrayContaining(["search.submit", "search.clear"]));
    expect(repeats(bundle.routes.cart.tree)).toContain("cart.lines");
    expect(bundle.routes.cart.trustedSlots.map((slot) => slot.kind)).toEqual(expect.arrayContaining(["cartLineControls", "cartSummary"]));
    expect(bundle.routes.checkout.layout).toMatchObject({ columnMode: "summaryAside", spacingTokenId: "terminal-gap" });
    const text = Object.values(bundle.routes).map((route) => "html" in route ? route.html : route.decorativeHtml).join(" ");
    expect(text).toContain("0 matching records");
    expect(text).toContain("Sold out");
    expect(text).not.toMatch(/https?:\/\//);
    expect(Object.values(bundle.routes).filter((route): route is RouteArtifact => "html" in route).every((route) => route.css.includes("overflow-wrap:anywhere"))).toBe(true);
  });
});
