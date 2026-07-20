import { describe, expect, it } from "vitest";
import type { CompiledNode, RouteArtifact } from "~/lib/storefront-bundle/types";
import { proveStorefrontBundle } from "~/lib/storefront-validation/browser.server";
import { storefrontProofContext } from "~/lib/storefront-validation/fixtures";
import { DIAGNOSTIC_DECK_ASSETS } from "./assets";
import { DIAGNOSTIC_DECK_BUNDLE, DIAGNOSTIC_DECK_RECIPE } from "./bundle";

const repeats = (nodes: readonly CompiledNode[]): string[] => nodes.flatMap((node) => node.kind === "text" ? [] : [...(node.repeat ? [node.repeat.source] : []), ...repeats(node.children)]);
const actions = (route: RouteArtifact) => route.interactions.transitions.map((item) => item.action.type);

describe("diagnostic-deck storefront recipe", () => {
  it("styles dynamic product cards as the source exact-unit rows", () => {
    for (const surface of ["home", "collection"] as const) {
      const source = DIAGNOSTIC_DECK_RECIPE.config.surfaces[surface].source;
      expect(source.html).toContain('class="unit"');
      expect(source.html).toContain('class="thumb"');
      expect(source.html).toContain('class="unitName"');
      expect(source.html).toContain('class="unit-link" data-cd-route="product"');
      expect(source.html).toContain('class="grade"');
      expect(source.html).toContain('class="passport passport-evidence"');
      expect(source.html).toContain('class="unit-action commerce-target"');
      expect(source.html).toContain('class="commerce-fallback"');
      expect(source.css).toContain(".unit>div");
      expect(source.css).toContain(".unitName b");
      expect(source.css).toContain("minmax(160px,auto)");
      expect(source.css).toContain("--commerce-surface:var(--paper)");
      expect(source.css).toContain("--commerce-accent:var(--green)");
    }
    expect(DIAGNOSTIC_DECK_RECIPE.config.surfaces.home.source.css).toContain(".unitName small{color:#555a53}");
    expect(DIAGNOSTIC_DECK_RECIPE.config.surfaces.home.source.css).toContain(".unit>div:first-child{display:none}");
  });

  it("lays out collection products as rows on the repeated diagnostic matrix", () => {
    const collection = DIAGNOSTIC_DECK_RECIPE.config.surfaces.collection.source;

    expect(collection.html).toContain('class="matrix" data-cd-repeat="collection.products"');
    expect(collection.css).toMatch(/\.matrix\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*1fr/);
    expect(collection.css).toContain(".collectionTop{padding:46px 24px 22px");
    expect(collection.css).toContain(".filters{display:flex;gap:7px;padding:10px 24px");
  });

  it("keeps the original scan line and target reticle over the hero evidence image", () => {
    expect(DIAGNOSTIC_DECK_RECIPE.bundle.routes.home.html).toContain('class="scan"');
    expect(DIAGNOSTIC_DECK_RECIPE.bundle.routes.home.html).toContain('class="target"');
  });

  it("renders exact-unit imagery and availability in diagnostic search results", () => {
    const paths = DIAGNOSTIC_DECK_RECIPE.bundle.routes.search.bindings.map((binding) => binding.ref.kind === "data" ? binding.ref.path : null);
    expect(paths).toEqual(expect.arrayContaining(["product.primaryImage", "product.title", "product.description", "product.price", "product.availability"]));
  });

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
    expect(bundle.source).toEqual({ kind: "recipe", templateId: "diagnostic-deck", templateVersion: 10 });
    expect(config.archetype).toEqual({ composition: "diagnostic-terminal", hero: "grade-diagnostic-hero", scroll: "deck-snap", cards: "diagnostic-cards", iconography: ["terminal condition marks", "warranty status glyphs"] });
    expect(bundle.designSystem).toMatchObject({ displayFontId: "archivo-black", bodyFontId: "dm-mono", iconStyle: "terminal condition marks and warranty-status glyphs", motionStyle: "deck snap with evidence-panel expansion" });
    expect(new Set(Object.values(config.surfaces).map((surface) => surface.signature)).size).toBe(7);
    expect(DIAGNOSTIC_DECK_ASSETS.entries).toEqual([expect.objectContaining({ key: "hero", byteSize: 61226 })]);
    expect(bundle.routes.home.html).toContain('data-cd-asset-key="hero"');
    expect(bundle.routes.home.html).toContain("Known<br");
    expect(bundle.routes.home.html).toContain("12-month cover");
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
