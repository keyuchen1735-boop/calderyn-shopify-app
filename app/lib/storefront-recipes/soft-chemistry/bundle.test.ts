import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SOFT_CHEMISTRY_RECIPE } from "./bundle";

describe("Soft Chemistry storefront recipe", () => {
  it("compiles a clinical editorial routine across the full commerce contract", () => {
    const { bundle, config, report } = SOFT_CHEMISTRY_RECIPE;
    expect(report).toMatchObject({ ok: true, diagnostics: [] });
    expect(bundle.source).toEqual({ kind: "recipe", templateId: "soft-chemistry", templateVersion: 2 });
    expect(config.archetype).toMatchObject({ composition: "clinical-editorial", hero: "ingredient-routine-hero", scroll: "soft-reveal", cards: "ingredient-dossiers" });
    expect(bundle.designSystem).toMatchObject({ displayFontId: "source-serif-4", bodyFontId: "inter" });
    expect(new Set(Object.values(config.surfaces).map((surface) => surface.signature)).size).toBe(7);
    expect(bundle.assets.entries).toEqual([expect.objectContaining({ key: "hero", byteSize: 40456 })]);
    expect(existsSync(resolve(process.cwd(), "public/storefront-recipes/soft-chemistry", `${bundle.assets.entries[0]?.key}.webp`))).toBe(true);
    expect(bundle.shell.trustedSlots.map((slot) => slot.kind)).toContain("cartDrawer");
    expect(bundle.routes.home.html).toContain('data-cd-asset-key="hero"');
    expect(bundle.routes.home.html).toContain("Assemble the routine");
    expect(bundle.routes.home.interactions.transitions.map((transition) => transition.action.type)).toEqual(expect.arrayContaining(["tabs.select", "scroll.to"]));
    expect(bundle.routes.collection.html).toContain("No formulas match this concern");
    expect(bundle.routes.collection.bindings.map((binding) => binding.ref)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "collection.title" }), expect.objectContaining({ path: "product.primaryImage" }),
      expect.objectContaining({ path: "product.title" }), expect.objectContaining({ path: "product.price" }), expect.objectContaining({ path: "product.availability" }),
    ]));
    expect(bundle.routes.collection.interactions.transitions.map((transition) => transition.action.type)).toEqual(expect.arrayContaining(["collection.filter", "collection.sort"]));
    expect(bundle.routes.product.html).toContain("Unavailable formulas retain their ingredient dossier");
    expect(bundle.routes.product.bindings.map((binding) => binding.ref)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "product.primaryImage" }), expect.objectContaining({ path: "product.description" }), expect.objectContaining({ path: "variant.title" }),
    ]));
    expect(bundle.routes.product.trustedSlots.map((slot) => slot.kind)).toEqual(expect.arrayContaining(["variantPicker", "addToCart"]));
    expect(bundle.routes.product.interactions.transitions.map((transition) => transition.action.type)).toContain("accordion.toggle");
    expect(bundle.routes.search.interactions.transitions.map((transition) => transition.action.type)).toEqual(expect.arrayContaining(["search.update", "search.submit", "search.clear"]));
    expect(bundle.routes.search.html).toContain("No formula or ingredient result");
    expect(bundle.routes.cart.trustedSlots.map((slot) => slot.kind)).toEqual(expect.arrayContaining(["cartLineControls", "cartSummary"]));
    expect(bundle.routes.cart.html).toContain("Your routine is empty");
    expect(bundle.routes.checkout.layout).toEqual(expect.objectContaining({ columnMode: "single", sectionOrder: ["contact", "shipping", "delivery", "consent", "payment", "summary"] }));
    expect(bundle.routes.checkout.requiredData.map((item) => item.kind)).toEqual(expect.arrayContaining(["storeIdentity", "policyLinks"]));
    expect(bundle.designSystem.globalCss).toContain("overflow-wrap: anywhere");
  });
});
