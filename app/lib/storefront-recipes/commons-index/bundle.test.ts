import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { COMMONS_INDEX_RECIPE } from "./bundle";

describe("Commons Index storefront recipe", () => {
  it("compiles a cooperative provenance ledger across every commerce surface", () => {
    const { bundle, config, report } = COMMONS_INDEX_RECIPE;
    expect(report).toMatchObject({ ok: true, diagnostics: [] });
    expect(bundle.source).toEqual({ kind: "recipe", templateId: "commons-index", templateVersion: 2 });
    expect(config.archetype).toMatchObject({ composition: "cooperative-directory", hero: "impact-ledger-intro", scroll: "indexed-ledger", cards: "provenance-records" });
    expect(bundle.designSystem).toMatchObject({ displayFontId: "fraunces", bodyFontId: "atkinson-hyperlegible" });
    expect(new Set(Object.values(config.surfaces).map((surface) => surface.signature)).size).toBe(7);
    expect(bundle.assets.entries).toEqual([expect.objectContaining({ key: "hero", byteSize: 130446 })]);
    expect(existsSync(resolve(process.cwd(), "public/storefront-recipes/commons-index", `${bundle.assets.entries[0]?.key}.webp`))).toBe(true);
    expect(bundle.shell.bindings.map((binding) => binding.ref)).toContainEqual(expect.objectContaining({ path: "store.name" }));
    expect(bundle.shell.trustedSlots.map((slot) => slot.kind)).toContain("cartDrawer");
    expect(bundle.routes.home.html).toContain('data-cd-asset-key="hero"');
    expect(bundle.routes.home.html).toContain("Trace the refill loop");
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
