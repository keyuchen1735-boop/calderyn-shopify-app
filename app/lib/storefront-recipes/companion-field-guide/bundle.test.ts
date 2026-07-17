import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { COMPANION_FIELD_GUIDE_RECIPE } from "./bundle";

describe("Companion Field Guide storefront recipe", () => {
  it("keeps the mobile profile heading on its own row above bounded controls", () => {
    const css = COMPANION_FIELD_GUIDE_RECIPE.config.surfaces.home.source.css;
    expect(css).toContain(".profile-rail { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:.5rem; position:static }");
    expect(css).toContain(".profile-rail h2 { grid-column:1 / -1; margin:0 0 .5rem }");
    expect(css).toContain(".profile-rail button { min-width:0 }");
  });

  it("compiles a chaptered pet care guide across the complete commerce contract", () => {
    const { bundle, config, report } = COMPANION_FIELD_GUIDE_RECIPE;
    expect(report).toMatchObject({ ok: true, diagnostics: [] });
    expect(bundle.source).toEqual({ kind: "recipe", templateId: "companion-field-guide", templateVersion: 2 });
    expect(config.archetype).toMatchObject({ composition: "field-guide", hero: "pet-profile-hero", scroll: "chaptered-guide", cards: "field-notes" });
    expect(bundle.designSystem).toMatchObject({ displayFontId: "roboto-slab", bodyFontId: "atkinson-hyperlegible" });
    expect(new Set(Object.values(config.surfaces).map((surface) => surface.signature)).size).toBe(7);
    expect(bundle.assets.entries).toEqual([expect.objectContaining({ key: "hero", byteSize: 158522 })]);
    expect(existsSync(resolve(process.cwd(), "public/storefront-recipes/companion-field-guide", `${bundle.assets.entries[0]?.key}.webp`))).toBe(true);
    expect(bundle.shell.trustedSlots.map((slot) => slot.kind)).toContain("cartDrawer");
    expect(bundle.routes.home.html).toContain('data-cd-asset-key="hero"');
    expect(bundle.routes.home.html).toContain("Build a companion profile");
    expect(bundle.routes.home.interactions.state).toEqual(expect.arrayContaining([expect.objectContaining({ type: "enum", allowedValues: ["all", "dog", "cat", "senior"] })]));
    expect(bundle.routes.home.interactions.transitions.map((transition) => transition.action.type)).toEqual(expect.arrayContaining(["state.set", "scroll.to"]));
    expect(bundle.routes.collection.html).toContain("No essentials match this care chapter");
    expect(bundle.routes.collection.bindings.map((binding) => binding.ref)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "collection.title" }), expect.objectContaining({ path: "product.primaryImage" }),
      expect.objectContaining({ path: "product.title" }), expect.objectContaining({ path: "product.price" }), expect.objectContaining({ path: "product.availability" }),
    ]));
    expect(bundle.routes.collection.interactions.transitions.map((transition) => transition.action.type)).toEqual(expect.arrayContaining(["collection.filter", "collection.sort"]));
    expect(bundle.routes.product.html).toContain("Currently unavailable care notes remain readable");
    expect(bundle.routes.product.html).toContain("Serving and dosage");
    expect(bundle.routes.product.bindings.map((binding) => binding.ref)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "product.primaryImage" }), expect.objectContaining({ path: "product.description" }), expect.objectContaining({ path: "variant.title" }),
    ]));
    expect(bundle.routes.product.trustedSlots.map((slot) => slot.kind)).toEqual(expect.arrayContaining(["variantPicker", "addToCart"]));
    expect(bundle.routes.search.interactions.transitions.map((transition) => transition.action.type)).toEqual(expect.arrayContaining(["search.update", "search.submit", "search.clear"]));
    expect(bundle.routes.search.html).toContain("No matching care chapter");
    expect(bundle.routes.cart.trustedSlots.map((slot) => slot.kind)).toEqual(expect.arrayContaining(["cartLineControls", "cartSummary"]));
    expect(bundle.routes.cart.html).toContain("Your field bag is empty");
    expect(bundle.routes.checkout.layout).toEqual(expect.objectContaining({ columnMode: "summaryAside", sectionOrder: ["contact", "shipping", "delivery", "consent", "payment", "summary"] }));
    expect(bundle.routes.checkout.requiredData.map((item) => item.kind)).toEqual(expect.arrayContaining(["storeIdentity", "policyLinks"]));
    expect(bundle.designSystem.globalCss).toContain("overflow-wrap: anywhere");
  });
});
