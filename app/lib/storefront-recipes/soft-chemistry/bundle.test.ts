import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SOFT_CHEMISTRY_RECIPE } from "./bundle";

describe("Soft Chemistry storefront recipe", () => {
  it("compiles a clinical editorial routine across the full commerce contract", () => {
    const { bundle, config, report } = SOFT_CHEMISTRY_RECIPE;
    expect(report).toMatchObject({ ok: true, diagnostics: [] });
    expect(bundle.source).toEqual({ kind: "recipe", templateId: "soft-chemistry", templateVersion: 5 });
    expect(config.archetype).toMatchObject({ composition: "clinical-editorial", hero: "ingredient-routine-hero", scroll: "soft-reveal", cards: "ingredient-dossiers" });
    expect(bundle.designSystem).toMatchObject({ displayFontId: "source-serif-4", bodyFontId: "inter" });
    expect(new Set(Object.values(config.surfaces).map((surface) => surface.signature)).size).toBe(7);
    expect(bundle.assets.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "hero", byteSize: 40456 }),
      expect.objectContaining({ key: "collection" }),
      expect.objectContaining({ key: "texture" }),
    ]));
    for (const asset of bundle.assets.entries) {
      expect(existsSync(resolve(process.cwd(), "public/storefront-recipes/soft-chemistry", `${asset.key}.webp`))).toBe(true);
    }
    expect(bundle.shell.trustedSlots.map((slot) => slot.kind)).toContain("cartDrawer");
    expect(bundle.routes.home.html).toContain('data-cd-asset-key="hero"');
    expect(bundle.routes.home.html).toContain("Skin, in its softer state.");
    expect(bundle.routes.home.interactions.transitions.map((transition) => transition.action.type)).toContain("scroll.to");
    expect(bundle.routes.collection.html).toContain("No formulas match this concern");
    expect(bundle.routes.collection.bindings.map((binding) => binding.ref)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "collection.title" }), expect.objectContaining({ path: "product.primaryImage" }),
      expect.objectContaining({ path: "product.title" }), expect.objectContaining({ path: "product.price" }), expect.objectContaining({ path: "product.availability" }),
    ]));
    expect(bundle.routes.collection.interactions.transitions.map((transition) => transition.action.type)).toEqual(expect.arrayContaining(["collection.filter", "collection.sort"]));
    expect(bundle.routes.product.bindings.map((binding) => binding.ref)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "product.primaryImage" }), expect.objectContaining({ path: "product.description" }),
    ]));
    expect(bundle.routes.product.trustedSlots.map((slot) => slot.kind)).toEqual(expect.arrayContaining(["variantPicker", "addToCart"]));
    expect(bundle.routes.search.interactions.transitions.map((transition) => transition.action.type)).toEqual(expect.arrayContaining(["search.update", "search.submit", "search.clear"]));
    expect(bundle.routes.search.html).toContain("No formula or ingredient result");
    expect(bundle.routes.cart.trustedSlots.map((slot) => slot.kind)).toEqual(expect.arrayContaining(["cartLineControls", "cartSummary"]));
    expect(bundle.routes.cart.html).toContain("Your routine is empty");
    expect(bundle.routes.checkout.layout).toEqual(expect.objectContaining({ columnMode: "summaryAside", sectionOrder: ["contact", "shipping", "delivery", "consent", "payment", "summary"] }));
    expect(bundle.routes.checkout.requiredData.map((item) => item.kind)).toEqual(expect.arrayContaining(["storeIdentity", "policyLinks"]));
    expect(bundle.designSystem.globalCss).toContain("overflow-wrap:anywhere");
  });

  it("preserves the approved full-bleed template while binding merchant products", () => {
    const { config } = SOFT_CHEMISTRY_RECIPE;
    expect(config.surfaces.shell.source.html).toContain('class="head"');
    expect(config.surfaces.home.source.html).toEqual(expect.stringContaining('class="hero"'));
    expect(config.surfaces.home.source.html).toEqual(expect.stringContaining('class="orbital"'));
    expect(config.surfaces.home.source.html).toEqual(expect.stringContaining('class="ritual"'));
    expect(config.surfaces.home.source.html).toEqual(expect.stringContaining('class="formula-stack"'));
    expect(config.surfaces.home.source.html).toEqual(expect.stringContaining('class="concerns"'));
    expect(config.surfaces.home.source.html).toEqual(expect.stringContaining('class="products"'));
    expect(config.surfaces.home.source.html).toEqual(expect.stringContaining('class="rail"'));
    expect(config.surfaces.home.source.html).toContain('data-cd-src="product.primaryImage"');
    expect(config.surfaces.home.source.html).toContain('data-cd-text="product.description"');
    expect(config.surfaces.home.source.css).toContain("@keyframes spin");
    expect(config.surfaces.home.source.css).toContain("animation:counter-spin 30s linear infinite");
    expect(config.surfaces.home.source.css).toContain("@keyframes counter-spin");
    expect(config.surfaces.collection.source.html).toEqual(expect.stringContaining('class="col-head"'));
    expect(config.surfaces.collection.source.html).toContain('data-cd-asset="collection"');
    expect(config.surfaces.collection.source.html).toEqual(expect.stringContaining('class="filters"'));
    expect(config.surfaces.collection.source.html).toEqual(expect.stringContaining('class="grid"'));
    expect(config.surfaces.product.source.html).toEqual(expect.stringContaining('class="pdp"'));
    expect(config.surfaces.product.source.html).toEqual(expect.stringContaining('class="gallery"'));
    expect(config.surfaces.product.source.html).toEqual(expect.stringContaining('class="detail"'));
    expect(config.surfaces.product.source.html).toContain('data-cd-asset="texture"');
    expect(config.surfaces.product.source.html).toContain('<section><div data-cd-slot="variantPicker"');
    expect(config.surfaces.product.source.html).toContain('data-cd-slot="addToCart"');
    expect(config.surfaces.product.source.html).not.toContain("Unavailable formulas retain");
    expect(config.surfaces.product.source.html).not.toContain('data-cd-repeat="product.variants"');
    expect(config.surfaces.product.source.css).toContain("width:min(1090px,calc(100% - 26px))");
    expect(config.surfaces.product.source.css).toContain("font-size:52px");
    expect(config.surfaces.product.source.css).toContain("-webkit-line-clamp:3");
    expect(config.surfaces.search.source.css).toContain("white-space:nowrap");
    expect(config.surfaces.cart.source.html).toContain('class="cart-intro"');
    expect(config.surfaces.checkout.source.html).toContain('class="checkout-frame"');
    expect(config.surfaces.shell.source.css).toContain(".niche-icon,.brand-live,.account-link{display:none;color:inherit;text-decoration:none}");
  });
});
