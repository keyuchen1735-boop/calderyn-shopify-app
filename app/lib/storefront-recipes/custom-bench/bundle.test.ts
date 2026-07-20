import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CUSTOM_BENCH_RECIPE } from "./bundle";

function contrastRatio(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    const channels = hex.slice(1).match(/.{2}/g)!.map((value) => Number.parseInt(value, 16) / 255)
      .map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return .2126 * channels[0]! + .7152 * channels[1]! + .0722 * channels[2]!;
  };
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0]! + .05) / (values[1]! + .05);
}

describe("Custom Bench storefront recipe", () => {
  it("preserves the approved proof workbench around live merchant products", () => {
    const { config } = CUSTOM_BENCH_RECIPE;
    const home = config.surfaces.home.source;

    for (const className of ["hero", "proof-copy", "proof", "stepper", "stage", "controls", "rail-section", "rail", "showcase"]) {
      expect(home.html).toContain(`class="${className}`);
    }
    expect(home.html).toContain("Personal objects composed one detail at a time.");
    expect(home.html).toContain("Made after you approve.");
    expect(home.html).toContain('data-cd-repeat="featured.products"');
    expect(home.html).toContain('data-cd-src="product.primaryImage"');
    expect(home.html).toContain('data-cd-text="product.title"');
    expect(home.html).toContain('data-cd-money="product.price"');
    expect(home.css).toContain("grid-template-columns:44% 56%");
  });

  it("lays out collection products as a material specimen grid on the repeated owner", () => {
    const collection = CUSTOM_BENCH_RECIPE.config.surfaces.collection.source;

    expect(collection.html).toContain('<div class="catalog"><section class="catalog-grid" data-cd-repeat="collection.products"');
    expect(collection.css).toContain(".catalog { display: grid; grid-template-columns: repeat(3, 1fr) }");
    expect(collection.css).toContain(".catalog-grid { display: contents }");
    expect(collection.css).toContain(".catalog { grid-template-columns: 1fr }");
  });

  it("keeps the collection head compact so workshop filters and products enter the first viewport", () => {
    const collection = CUSTOM_BENCH_RECIPE.config.surfaces.collection.source;

    expect(collection.html).toContain('<header class="catalog-intro"><div class="catalog-copy">');
    expect(collection.html).toContain('</div><img data-cd-src="collection.image"');
    expect(collection.css).toContain("min-height: 310px");
    expect(collection.css).toContain("max-width: 8ch; margin: 12px 0");
    expect(collection.css).toContain(".catalog-intro img { height: 310px");
  });

  it("keeps prototype product cards across home and collection", () => {
    const { home, collection } = CUSTOM_BENCH_RECIPE.config.surfaces;
    for (const surface of [home.source, collection.source]) {
      expect(surface.html).toContain('article class="card"');
      expect(surface.html).toContain('class="card-info"');
      expect(surface.html).toContain('class="meta"');
    }
    expect(home.source.css).toContain("--commerce-surface:var(--paper)");
    expect(home.source.css).toContain(".card-info{display:grid;grid-template-columns:1fr auto");
  });

  it("compiles the workshop configurator across the full commerce contract", () => {
    const { bundle, config, report } = CUSTOM_BENCH_RECIPE;

    expect(report).toMatchObject({ ok: true, diagnostics: [] });
    expect(bundle.source).toEqual({ kind: "recipe", templateId: "custom-bench", templateVersion: 11 });
    expect(config.archetype).toMatchObject({
      composition: "workshop-configurator",
      hero: "configurator-workbench",
      scroll: "guided-steps",
      cards: "material-specimen-grid",
    });
    expect(new Set(Object.values(config.surfaces).map((surface) => surface.signature)).size).toBe(7);
    expect(bundle.designSystem).toMatchObject({ displayFontId: "barlow-condensed", bodyFontId: "manrope" });
    expect(contrastRatio(bundle.designSystem.tokens.signal!, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(bundle.assets.entries).toEqual([
      expect.objectContaining({ key: "hero", mediaType: "image/webp", byteSize: 121470 }),
    ]);
    expect(existsSync(resolve(process.cwd(), "public/storefront-recipes/custom-bench", `${bundle.assets.entries[0]?.key}.webp`))).toBe(true);

    expect(bundle.shell.bindings.map((binding) => binding.ref)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "store.name" }),
    ]));
    expect(bundle.shell.trustedSlots.map((slot) => slot.kind)).toContain("cartDrawer");
    expect(bundle.routes.home.html).toContain('data-cd-asset-key="hero"');
    expect(bundle.routes.home.html).toContain(">Approve<");
    expect(bundle.routes.home.interactions.transitions.map((transition) => transition.action.type)).toEqual(
      expect.arrayContaining(["state.set", "scroll.to"]),
    );

    expect(bundle.routes.collection.html).toContain("No objects match these workshop filters");
    expect(bundle.routes.collection.bindings.map((binding) => binding.ref)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "collection.title" }),
      expect.objectContaining({ path: "product.primaryImage" }),
      expect.objectContaining({ path: "product.title" }),
      expect.objectContaining({ path: "product.price" }),
      expect.objectContaining({ path: "product.availability" }),
    ]));
    expect(bundle.routes.collection.interactions.transitions.map((transition) => transition.action.type)).toEqual(
      expect.arrayContaining(["collection.filter", "collection.sort"]),
    );

    expect(bundle.routes.product.bindings.map((binding) => binding.ref)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "product.primaryImage" }),
      expect.objectContaining({ path: "product.description" }),
      expect.objectContaining({ path: "product.availability" }),
      expect.objectContaining({ path: "variant.title" }),
    ]));
    expect(bundle.routes.product.trustedSlots.map((slot) => slot.kind)).toEqual(
      expect.arrayContaining(["variantPicker", "addToCart"]),
    );
    expect(bundle.routes.product.html).toContain("Sold out pieces remain visible");

    expect(bundle.routes.search.interactions.transitions.map((transition) => transition.action.type)).toEqual(
      expect.arrayContaining(["search.update", "search.submit", "search.clear"]),
    );
    expect(bundle.routes.search.html).toContain("No workshop results yet");
    expect(bundle.routes.cart.trustedSlots.map((slot) => slot.kind)).toEqual(
      expect.arrayContaining(["cartLineControls", "cartSummary"]),
    );
    expect(bundle.routes.cart.html).toContain("Your commission is empty");
    expect(bundle.routes.checkout.layout).toEqual(expect.objectContaining({
      columnMode: "summaryAside",
      sectionOrder: ["contact", "shipping", "delivery", "consent", "payment", "summary"],
    }));
    expect(bundle.routes.checkout.requiredData.map((requirement) => requirement.kind)).toEqual(
      expect.arrayContaining(["storeIdentity", "policyLinks"]),
    );
    expect(bundle.designSystem.globalCss).toContain("overflow-wrap: anywhere");
  });
});
