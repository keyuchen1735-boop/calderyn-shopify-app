import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compileRecipeConfig } from "../factory";
import { ATELIER_ASSETS } from "./assets";
import { ATELIER_RECIPE_CONFIG } from "./bundle";

const ROUTES = [
  "home",
  "collections",
  "collection",
  "product",
  "search",
  "story",
  "cart",
  "checkout",
  "notFound",
] as const;

describe("Atelier storefront recipe", () => {
  it("compiles nine distinct fit-laboratory routes without Atelier Grid's magazine structure", () => {
    const result = compileRecipeConfig(ATELIER_RECIPE_CONFIG);

    expect(ROUTES.every((route) => ATELIER_RECIPE_CONFIG.surfaces[route])).toBe(
      true,
    );
    expect(
      new Set(
        ROUTES.map((route) => ATELIER_RECIPE_CONFIG.surfaces[route].signature),
      ).size,
    ).toBe(9);
    expect(ATELIER_RECIPE_CONFIG.archetype).toMatchObject({
      composition: "fit-laboratory",
      hero: "fabric-study-hero",
      scroll: "fit-study",
      cards: "garment-studies",
    });
    expect(ATELIER_RECIPE_CONFIG.designSystem.tokens).toMatchObject({
      stone: "#ebe6dd",
      oxblood: "#681f2b",
    });
    expect(JSON.stringify(ATELIER_RECIPE_CONFIG)).not.toMatch(
      /asymmetric-magazine|editorial-grid-hero|magazine-grid/,
    );
    expect(new Set(result.report.diagnostics.map(({ code }) => code))).toEqual(
      new Set([
        "asset.reference_missing",
        "route.html_mismatch",
        "tree.control_attribute",
      ]),
    );
  });

  it("binds live garments and variants to the fit and purchase flow", () => {
    const { bundle } = compileRecipeConfig(ATELIER_RECIPE_CONFIG);
    const product = bundle.routes.product;

    expect(
      bundle.routes.home.bindings.map(({ ref }) =>
        ref.kind === "data" ? ref.path : null,
      ),
    ).toEqual(
      expect.arrayContaining([
        "product.primaryImage",
        "product.title",
        "product.price",
        "product.availability",
      ]),
    );
    expect(
      ATELIER_RECIPE_CONFIG.surfaces.product.source.html,
    ).toContain('data-cd-repeat="product.variants"');
    expect(
      product.bindings.map(({ ref }) =>
        ref.kind === "data" ? ref.path : null,
      ),
    ).toEqual(
      expect.arrayContaining([
        "product.title",
        "product.description",
        "product.price",
        "product.availability",
        "variant.title",
        "variant.availability",
      ]),
    );
    expect(product.trustedSlots.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(["variantPicker", "addToCart"]),
    );
    expect(
      product.trustedSlots.filter(({ kind }) => kind === "addToCart"),
    ).toHaveLength(2);
    expect(bundle.shell.trustedSlots.map(({ kind }) => kind)).toContain(
      "cartDrawer",
    );
  });

  it("keeps fit-finder answers and size-confidence evidence in declarative local state", () => {
    const { bundle } = compileRecipeConfig(ATELIER_RECIPE_CONFIG);
    const product = bundle.routes.product;

    expect(product.interactions.state.map(({ type }) => type)).toEqual(
      expect.arrayContaining(["enum", "index"]),
    );
    expect(
      product.interactions.transitions.map(({ action }) => action.type),
    ).toEqual(
      expect.arrayContaining([
        "state.set",
        "state.increment",
        "state.decrement",
      ]),
    );
    expect(product.html).toContain("Garment measurements");
    expect(product.html).toContain("Size confidence");
    expect(product.html).toContain(
      "Recommendation withheld when measurements are incomplete",
    );
  });

  it("declares exactly three poster-first video briefs while media proof remains honestly blocked", () => {
    const { bundle, report } = compileRecipeConfig(ATELIER_RECIPE_CONFIG);
    const brief = readFileSync(new URL("./video-brief.md", import.meta.url), "utf8");
    const html = [bundle.routes.home.html, bundle.routes.product.html].join(
      "\n",
    );
    const keys = [
      "hero-poster",
      "hero-webm",
      "hero-mp4",
      "hero-alt-poster",
      "hero-alt-webm",
      "hero-alt-mp4",
      "pdp-detail-poster",
      "pdp-detail-webm",
      "pdp-detail-mp4",
    ];

    expect(html.match(/data-cd-video/g) ?? []).toHaveLength(3);
    expect(
      brief.match(
        /^\[VIDEO BRIEF — atelier \/ (hero|hero-alt|pdp-detail)\]$/gm,
      ),
    ).toHaveLength(3);
    for (const key of keys) expect(html).toContain(key);
    expect(ATELIER_ASSETS.entries).toEqual([]);
    expect(report.ok).toBe(false);
    expect(new Set(report.diagnostics.map(({ code }) => code))).toEqual(
      new Set([
        "asset.reference_missing",
        "route.html_mismatch",
        "tree.control_attribute",
      ]),
    );
  });

  it("provides protected cart controls and a live order ledger", () => {
    const { bundle } = compileRecipeConfig(ATELIER_RECIPE_CONFIG);
    expect(bundle.routes.cart.trustedSlots.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(["cartLineControls", "cartSummary"]),
    );
    expect(
      bundle.routes.cart.bindings.map(({ ref }) =>
        ref.kind === "data" ? ref.path : null,
      ),
    ).toEqual(
      expect.arrayContaining([
        "cartLine.title",
        "cartLine.quantity",
        "cartLine.total",
        "cart.subtotal",
      ]),
    );
  });
});
