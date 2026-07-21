import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CompiledNode, RouteArtifact } from "~/lib/storefront-bundle/types";
import { BROADCAST_PATCH_BAY_ASSETS } from "./assets";
import { BROADCAST_PATCH_BAY_RECIPE } from "./bundle";

const repeats = (nodes: readonly CompiledNode[]): string[] => nodes.flatMap((node) => node.kind === "text" ? [] : [...(node.repeat ? [node.repeat.source] : []), ...repeats(node.children)]);
const actions = (route: RouteArtifact) => route.interactions.transitions.map((item) => item.action.type);
const CANONICAL_HTML = readFileSync(path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../docs/superpowers/prototypes/storefront-recipes/broadcast-patch-bay.html",
), "utf8");

describe("broadcast-patch-bay storefront recipe", () => {
  it("preserves the approved split hero geometry and concise source copy", () => {
    const { html, css } = BROADCAST_PATCH_BAY_RECIPE.config.surfaces.home.source;
    for (const className of ["hero", "heroCopy", "heroMedia", "heroTag", "wave"]) {
      expect(CANONICAL_HTML).toMatch(new RegExp(`class="[^"]*\\b${className}\\b`));
      expect(html).toMatch(new RegExp(`class="[^"]*\\b${className}\\b`));
      expect(css).toContain(`.${className}`);
    }
    expect(html).toContain("Build the<br><span>clean signal.</span>");
    expect(html).toContain("Low-latency controls, clear audio and the exact links between.");
    expect(css).toContain(".heroCopy h1{margin:30px 0;font-family:var(--font-display);font-weight:700;letter-spacing:-.065em;line-height:.82;text-transform:uppercase}");
  });

  it("preserves the signal-chain, live merchandising, and loadout compositions", () => {
    const { html, css } = BROADCAST_PATCH_BAY_RECIPE.config.surfaces.home.source;
    for (const className of ["signalSection", "sectionHead", "chain", "channel", "merch", "productGrid", "loadout", "builder", "switches", "rack"]) {
      expect(CANONICAL_HTML).toMatch(new RegExp(`class="[^"]*\\b${className}\\b`));
      expect(html).toMatch(new RegExp(`class="[^"]*\\b${className}\\b`));
      expect(css).toContain(`.${className}`);
    }
    expect(html).toContain("Every node is a live collection role.");
    expect(html).toContain("One desk.<br>One clean<br>route.");
    expect(actions(BROADCAST_PATCH_BAY_RECIPE.bundle.routes.home)).toContain("tabs.select");
  });

  it("keeps the live catalog in a static responsive module grid", () => {
    const { html, css } = BROADCAST_PATCH_BAY_RECIPE.config.surfaces.collection.source;
    expect(html).toContain('class="productCatalog"><div class="productGrid" data-cd-repeat="collection.products"');
    expect(css).toContain(".productCatalog{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;padding:35px 4vw 90px}");
    expect(css).toContain(".productGrid{display:contents}");
    expect(css).toContain(".collection{display:block}");
    expect(css).toContain(".productCatalog{grid-template-columns:1fr 1fr}");
  });

  it("keeps module cards faithful and themes their purchase controls", () => {
    const { home, collection } = BROADCAST_PATCH_BAY_RECIPE.config.surfaces;
    for (const surface of [home, collection]) {
      expect(surface.source.html).toMatch(/<article class="card"[^>]*><a[^>]*><div class="cardMedia"><img[^>]*><span class="cardCode"/);
      expect(surface.source.html).toContain('<div class="cardBody"><h3 data-cd-text="product.title"></h3><small data-cd-text="product.description"></small><div class="cardLine"><b data-cd-money="product.price"></b><span class="stock" data-cd-text="product.availability"></span></div></div>');
      expect(surface.source.css).toContain("--commerce-surface:var(--panel);--commerce-foreground:var(--white);--commerce-accent:var(--signal);--commerce-accent-foreground:var(--black)");
    }
    expect(home.source.css).toContain(".cardBody small{display:block;color:var(--muted);overflow-wrap:anywhere}");
  });

  it("compiles a modular signal patch bay and complete creator-commerce route matrix", () => {
    const { bundle, config, report } = BROADCAST_PATCH_BAY_RECIPE;
    expect(report).toMatchObject({ profileVersion: 1, ok: true, diagnostics: [] });
    expect(bundle.source).toEqual({ kind: "recipe", templateId: "broadcast-patch-bay", templateVersion: 11 });
    expect(config.archetype).toEqual({ composition: "signal-patch-bay", hero: "rig-signal-chain", scroll: "modular-patching", cards: "signal-modules", iconography: ["signal path glyphs", "compatibility port marks"] });
    expect(bundle.designSystem).toMatchObject({ displayFontId: "chakra-petch", bodyFontId: "dm-mono", iconStyle: "signal-path glyphs and compatibility-port marks", motionStyle: "modular patch transitions with reduced-motion static routing" });
    expect(new Set(Object.values(config.surfaces).map((surface) => surface.signature)).size).toBe(7);
    expect(BROADCAST_PATCH_BAY_ASSETS.entries).toEqual([expect.objectContaining({ key: "hero", byteSize: 201692 })]);
    expect(bundle.routes.home.html).toContain('data-cd-asset-key="hero"');
    expect(bundle.routes.home.html).toContain("Play");
    expect(bundle.routes.home.html).toContain("Publish");
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
    expect(bundle.routes.checkout.layout).toMatchObject({ columnMode: "summaryFirst", spacingTokenId: "rack-gap" });
    const text = Object.values(bundle.routes).map((route) => "html" in route ? route.html : route.decorativeHtml).join(" ");
    expect(text).toContain("No compatible signal found");
    expect(text).toContain("Sold out");
    expect(text).toContain("Compatibility");
    expect(text).not.toMatch(/https?:\/\//);
    expect(Object.values(bundle.routes).filter((route): route is RouteArtifact => "html" in route).every((route) => route.css.includes("overflow-wrap:anywhere"))).toBe(true);
  });
});
