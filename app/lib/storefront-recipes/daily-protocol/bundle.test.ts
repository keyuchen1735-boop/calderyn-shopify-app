import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DAILY_PROTOCOL_RECIPE } from "./bundle";

describe("Daily Protocol storefront recipe", () => {
  it("styles dynamic product cards as the source ledger rows", () => {
    for (const surface of ["home", "collection"] as const) {
      const source = DAILY_PROTOCOL_RECIPE.config.surfaces[surface].source;
      expect(source.html).toContain('class="ledger-row"');
      expect(source.html).toContain('class="ledger-image"');
      expect(source.html).toContain('class="ledger-name"');
      expect(source.html).toContain('class="ledger-cell glyph-line"');
      expect(source.html).toContain('class="row-action commerce-target"');
      expect(source.html).toContain('class="commerce-fallback"');
      expect(source.html).toContain('class="ledger-cell format-cell"');
      expect(source.html).toContain('class="ledger-cell serving-cell"');
      expect(source.css).toMatch(/\.ledger-row\s*\{[^}]*grid-template-columns:/);
      expect(source.css).toContain("minmax(150px,auto)");
      expect(source.css).toContain(".ledger-title{color:var(--ink);text-decoration:none");
      expect(source.css).toContain("--commerce-surface:var(--paper)");
      expect(source.css).toContain("--commerce-accent:var(--cobalt)");
    }
  });

  it("lays out collection products as ledger rows on the repeated owner", () => {
    const collection = DAILY_PROTOCOL_RECIPE.config.surfaces.collection.source;

    expect(collection.html).toContain('class="ledger-rows" data-cd-repeat="collection.products"');
    expect(collection.css).toMatch(/\.ledger-rows\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*1fr/);
  });

  it("preserves the approved day arc and dense live product ledger", () => {
    const home = DAILY_PROTOCOL_RECIPE.config.surfaces.home.source;

    for (const className of ["day-arc", "arc-map", "page", "hero", "hero-image", "hero-copy", "hero-metrics", "protocol-section", "protocol-stack", "ledger-section", "ledger", "ledger-row"]) {
      expect(home.html).toContain(`class="${className}`);
    }
    expect(DAILY_PROTOCOL_RECIPE.config.surfaces.shell.source.html).toContain('class="nav"');
    expect(home.html).toContain("A clear daily protocol built from products you can understand");
    expect(home.html).toContain("Dense by design: timing, form, serving, stock, and price");
    expect(home.html).toContain('data-cd-repeat="featured.products"');
    expect(home.html).toContain('data-cd-src="product.primaryImage"');
    expect(home.html).toContain('data-cd-text="product.title"');
    expect(home.html).toContain('data-cd-money="product.price"');
    expect(home.css).toContain("grid-template-columns:220px 1fr");
  });

  it("compiles a timed protocol ledger across the complete commerce contract", () => {
    const { bundle, config, report } = DAILY_PROTOCOL_RECIPE;
    expect(report).toMatchObject({ ok: true, diagnostics: [] });
    expect(bundle.source).toEqual({ kind: "recipe", templateId: "daily-protocol", templateVersion: 8 });
    expect(config.archetype).toMatchObject({ composition: "protocol-ledger", hero: "time-of-day-protocol", scroll: "routine-timeline", cards: "protocol-stacks" });
    expect(bundle.designSystem).toMatchObject({ displayFontId: "manrope", bodyFontId: "dm-mono" });
    expect(new Set(Object.values(config.surfaces).map((surface) => surface.signature)).size).toBe(7);
    expect(bundle.assets.entries).toEqual([expect.objectContaining({ key: "hero", byteSize: 297054 })]);
    expect(existsSync(resolve(process.cwd(), "public/storefront-recipes/daily-protocol", `${bundle.assets.entries[0]?.key}.webp`))).toBe(true);
    expect(bundle.shell.trustedSlots.map((slot) => slot.kind)).toContain("cartDrawer");
    expect(bundle.routes.home.html).toContain('data-cd-asset-key="hero"');
    expect(bundle.routes.home.html).toContain("Assemble the daily protocol");
    expect(bundle.routes.home.interactions.state).toEqual(expect.arrayContaining([expect.objectContaining({ type: "enum", allowedValues: ["all", "am", "mid", "pm"] })]));
    expect(bundle.routes.home.interactions.transitions.map((transition) => transition.action.type)).toEqual(expect.arrayContaining(["state.set", "scroll.to"]));
    expect(bundle.routes.collection.html).toContain("No live products match this protocol window");
    expect(bundle.routes.collection.bindings.map((binding) => binding.ref)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "collection.title" }), expect.objectContaining({ path: "product.primaryImage" }),
      expect.objectContaining({ path: "product.title" }), expect.objectContaining({ path: "product.price" }), expect.objectContaining({ path: "product.availability" }),
    ]));
    expect(bundle.routes.collection.interactions.transitions.map((transition) => transition.action.type)).toEqual(expect.arrayContaining(["collection.filter", "collection.sort"]));
    expect(bundle.routes.product.html).toContain("Timing and serving");
    expect(bundle.routes.product.html).toContain("Unavailable protocols keep their evidence visible");
    expect(bundle.routes.product.bindings.map((binding) => binding.ref)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "product.primaryImage" }), expect.objectContaining({ path: "product.description" }), expect.objectContaining({ path: "variant.title" }),
    ]));
    expect(bundle.routes.product.trustedSlots.map((slot) => slot.kind)).toEqual(expect.arrayContaining(["variantPicker", "addToCart"]));
    expect(bundle.routes.search.interactions.transitions.map((transition) => transition.action.type)).toEqual(expect.arrayContaining(["search.update", "search.submit", "search.clear"]));
    expect(bundle.routes.search.html).toContain("No protocol result");
    expect(bundle.routes.cart.trustedSlots.map((slot) => slot.kind)).toEqual(expect.arrayContaining(["cartLineControls", "cartSummary"]));
    expect(bundle.routes.cart.html).toContain("Your routine bag is empty");
    expect(bundle.routes.checkout.layout).toEqual(expect.objectContaining({ columnMode: "summaryFirst", sectionOrder: ["summary", "contact", "shipping", "delivery", "consent", "payment"] }));
    expect(bundle.routes.checkout.requiredData.map((item) => item.kind)).toEqual(expect.arrayContaining(["storeIdentity", "policyLinks"]));
    expect(bundle.designSystem.globalCss).toContain("overflow-wrap: anywhere");
  });
});
