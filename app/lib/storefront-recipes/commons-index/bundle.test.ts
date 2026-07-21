import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { COMMONS_INDEX_RECIPE } from "./bundle";

describe("Commons Index storefront recipe", () => {
  it("preserves the approved civic atlas around live provenance records", () => {
    const home = COMMONS_INDEX_RECIPE.config.surfaces.home.source;

    for (const className of ["atlas", "atlas-rail", "atlas-main", "hero-img", "hero-copy", "hero-bottom", "evidence", "specimens", "strip", "ledger", "ledger-copy", "ledger-map"]) {
      expect(home.html).toContain(`class="${className}`);
    }
    expect(home.html).toContain("A living index of small-batch goods");
    expect(home.html).toContain("Proof before promise.");
    expect(home.html).toContain('data-cd-repeat="featured.products"');
    expect(home.html).toContain('data-cd-src="product.primaryImage"');
    expect(home.html).toContain('data-cd-text="product.title"');
    expect(home.html).toContain('data-cd-money="product.price"');
    expect(home.css).toContain("grid-template-columns:220px 1fr");
  });

  it("keeps collection products in a single-column record table on the repeated owner", () => {
    const collection = COMMONS_INDEX_RECIPE.config.surfaces.collection.source;

    expect(collection.html).toContain('<div class="record-catalog"><section class="record-table" data-cd-repeat="collection.products"');
    expect(collection.css).toContain(".record-catalog { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)) }");
    expect(collection.css).toContain(".record-table { display:contents }");
  });

  it("keeps the directory head compact so evidence filters and records enter the first viewport", () => {
    const collection = COMMONS_INDEX_RECIPE.config.surfaces.collection.source;

    expect(collection.html).toContain('<header class="directory-head"><div class="directory-copy">');
    expect(collection.html).toContain('</div><img data-cd-src="collection.image"');
    expect(collection.css).toContain("min-height:330px");
    expect(collection.css).toContain("margin:10px 0");
    expect(collection.css).toContain(".directory-head img { height:330px");
  });

  it("keeps prototype evidence cards across home and collection", () => {
    const { home, collection } = COMMONS_INDEX_RECIPE.config.surfaces;
    for (const surface of [home.source, collection.source]) {
      expect(surface.html).toContain('article class="product"');
      expect(surface.html).toContain('class="proof"');
      expect(surface.html).toContain('class="pbody"');
    }
    expect(home.source.css).toContain("--commerce-accent:var(--acid)");
    expect(home.source.css).toContain(".pbody{display:grid;grid-template-columns:1fr auto");
  });

  it("compiles a cooperative provenance ledger across every commerce surface", () => {
    const { bundle, config, report } = COMMONS_INDEX_RECIPE;
    expect(report).toMatchObject({ ok: true, diagnostics: [] });
    expect(bundle.source).toEqual({ kind: "recipe", templateId: "commons-index", templateVersion: 11 });
    expect(config.archetype).toMatchObject({ composition: "cooperative-directory", hero: "impact-ledger-intro", scroll: "indexed-ledger", cards: "provenance-records" });
    expect(bundle.designSystem).toMatchObject({ displayFontId: "source-fraunces", bodyFontId: "dm-mono" });
    expect(new Set(Object.values(config.surfaces).map((surface) => surface.signature)).size).toBe(7);
    expect(bundle.assets.entries).toEqual([expect.objectContaining({ key: "hero", byteSize: 156350 })]);
    expect(existsSync(resolve(process.cwd(), "public/storefront-recipes/commons-index", `${bundle.assets.entries[0]?.key}.webp`))).toBe(true);
    expect(bundle.shell.bindings.map((binding) => binding.ref)).toContainEqual(expect.objectContaining({ path: "store.name" }));
    expect(bundle.shell.trustedSlots.map((slot) => slot.kind)).toContain("cartDrawer");
    expect(bundle.routes.home.html).toContain('data-cd-asset-key="hero"');
    expect(bundle.routes.home.html).toContain("Browse all evidence");
    expect(bundle.routes.home.interactions.transitions.map((transition) => transition.action.type)).toEqual(expect.arrayContaining(["accordion.toggle", "scroll.to"]));
    expect(bundle.routes.collection.html).toContain("No records match this evidence filter");
    expect(bundle.routes.collection.bindings.map((binding) => binding.ref)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "collection.title" }), expect.objectContaining({ path: "product.primaryImage" }),
      expect.objectContaining({ path: "product.title" }), expect.objectContaining({ path: "product.price" }), expect.objectContaining({ path: "product.availability" }),
    ]));
    expect(bundle.routes.collection.interactions.transitions.map((transition) => transition.action.type)).toEqual(expect.arrayContaining(["collection.filter", "collection.sort"]));
    expect(bundle.routes.product.trustedSlots.map((slot) => slot.kind)).toEqual(expect.arrayContaining(["variantPicker", "addToCart"]));
    expect(bundle.routes.product.html).toContain("Unavailable records keep their provenance visible");
    expect(bundle.routes.product.bindings.map((binding) => binding.ref)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "product.description" }), expect.objectContaining({ path: "product.primaryImage" }), expect.objectContaining({ path: "variant.title" }),
    ]));
    expect(bundle.routes.search.interactions.transitions.map((transition) => transition.action.type)).toEqual(expect.arrayContaining(["search.update", "search.submit", "search.clear"]));
    expect(bundle.routes.search.html).toContain("No material or maker records found");
    expect(bundle.routes.cart.trustedSlots.map((slot) => slot.kind)).toEqual(expect.arrayContaining(["cartLineControls", "cartSummary"]));
    expect(bundle.routes.cart.html).toContain("The shared basket is empty");
    expect(bundle.routes.checkout.layout).toEqual(expect.objectContaining({ columnMode: "summaryFirst", sectionOrder: ["summary", "contact", "shipping", "delivery", "consent", "payment"] }));
    expect(bundle.routes.checkout.requiredData.map((item) => item.kind)).toEqual(expect.arrayContaining(["storeIdentity", "policyLinks"]));
    expect(bundle.designSystem.globalCss).toContain("overflow-wrap: anywhere");
  });
});
