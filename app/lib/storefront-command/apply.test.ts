import { describe, expect, it } from "vitest";
import { getStoreTemplate } from "../storefront-bundle/registry";
import type { StorefrontBundleV1 } from "../storefront-bundle/types";
import { ATELIER_GRID_BUNDLE } from "../storefront-recipes/atelier-nine/bundle";
import { CUSTOM_BENCH_BUNDLE } from "../storefront-recipes/custom-bench/bundle";
import { DAILY_PROTOCOL_BUNDLE } from "../storefront-recipes/daily-protocol/bundle";
import { STOREFRONT_RECIPES } from "../storefront-recipes";
import { applyStoreIntent } from "./apply";

const template = getStoreTemplate("custom-bench");
const bundle = (): StorefrontBundleV1 => structuredClone(CUSTOM_BENCH_BUNDLE);

describe("applyStoreIntent", () => {
  it("changes one slot without changing structure or assets", () => {
    const original = bundle();
    const result = applyStoreIntent(original, template, {
      kind: "update_text",
      slot: "heroTitle",
      value: "Summer starts here",
    });

    expect(result.bundle.routes.home.html).toContain("Summer starts here");
    expect(Object.keys(result.bundle.routes)).toEqual(Object.keys(original.routes));
    expect(result.bundle.assets).toEqual(original.assets);
    expect(result.bundle.routes.home.css).toBe(original.routes.home.css);
    expect(result.bundle.routes.home.interactions).toEqual(original.routes.home.interactions);
    expect(original.routes.home.html).not.toContain("Summer starts here");
  });

  it("rejects undeclared or markup text", () => {
    expect(() => applyStoreIntent(bundle(), template, {
      kind: "update_text",
      slot: "notDeclared",
      value: "Summer starts here",
    })).toThrowError(expect.objectContaining({ code: "storefront_template_integrity_failed" }));
    expect(() => applyStoreIntent(bundle(), template, {
      kind: "update_text",
      slot: "heroTitle",
      value: "<style>bad</style>",
    })).toThrowError(expect.objectContaining({ code: "storefront_template_integrity_failed" }));
  });

  it("updates the first declared section heading without touching sibling copy", () => {
    const result = applyStoreIntent(bundle(), template, {
      kind: "update_text",
      slot: "sectionHeading",
      value: "Made for long weekends",
    });

    expect(result.bundle.routes.home.html).toContain("Made for long weekends");
    expect(result.bundle.routes.home.html).toContain("Objects on the bench");
  });

  it("uses the first home heading when a design has no hero class", () => {
    const result = applyStoreIntent(DAILY_PROTOCOL_BUNDLE, getStoreTemplate("daily-protocol"), {
      kind: "update_text",
      slot: "heroTitle",
      value: "A steadier daily rhythm",
    });

    expect(result.bundle.routes.home.html).toContain("A steadier daily rhythm");
  });

  it("preserves nested title formatting while replacing its text values", () => {
    const originalSpanCount = ATELIER_GRID_BUNDLE.routes.home.html.match(/<span/g)?.length;
    const result = applyStoreIntent(ATELIER_GRID_BUNDLE, getStoreTemplate("atelier-nine"), {
      kind: "update_text",
      slot: "heroTitle",
      value: "Autumn Assembly",
    });

    expect(result.bundle.routes.home.html).toContain("Autumn");
    expect(result.bundle.routes.home.html).toContain("Assembly");
    expect(result.bundle.routes.home.html.match(/<span/g)?.length).toBe(originalSpanCount);
  });

  it("applies concrete slots and fails closed for absent optional slots across every design", () => {
    const absentSlots = new Set([
      ...STOREFRONT_RECIPES
        .filter((recipe) => recipe.config.templateId !== "atelier-nine")
        .map((recipe) => `${recipe.config.templateId}:announcement`),
      "room-modes:sectionHeading",
      "diagnostic-deck:sectionHeading",
    ]);

    for (const recipe of STOREFRONT_RECIPES) {
      const activeTemplate = getStoreTemplate(recipe.config.templateId);
      for (const slot of activeTemplate.overrideSurface.textSlots) {
        const operation = () => applyStoreIntent(recipe.bundle, activeTemplate, {
          kind: "update_text",
          slot,
          value: "Replacement copy",
        });
        const key = `${recipe.config.templateId}:${slot}`;
        if (absentSlots.has(key)) {
          expect(operation, key).toThrowError(expect.objectContaining({
            code: "storefront_template_integrity_failed",
          }));
        } else {
          expect(operation, key).not.toThrow();
        }
      }
    }
  });

  it("uses the same code-point copy cap as classification", () => {
    const value = "🧶".repeat(300);
    const result = applyStoreIntent(bundle(), template, {
      kind: "update_text",
      slot: "heroTitle",
      value,
    });

    expect(result.bundle.routes.home.html).toContain(value);
  });

  it("changes only featured product IDs", () => {
    const original = bundle();
    const result = applyStoreIntent(original, template, {
      kind: "update_merchandising",
      productIds: ["product-b", "product-a"],
    });

    expect(result.bundle.featuredProductIds).toEqual(["product-b", "product-a"]);
    expect(result.bundle.routes).toEqual(original.routes);
    expect(result.bundle.assets).toEqual(original.assets);
  });

  it("rejects featured IDs that collide after trimming", () => {
    expect(() => applyStoreIntent(bundle(), template, {
      kind: "update_merchandising",
      productIds: ["product-a", " product-a"],
    })).toThrowError(expect.objectContaining({ code: "storefront_template_integrity_failed" }));
  });

  it("changes only the bounded visual layer", () => {
    const original = bundle();
    const visualLayer = {
      kind: "fragment_shader" as const,
      source: "void main(){}",
      colors: ["#000000", "#111111", "#222222"] as [string, string, string],
    };
    const result = applyStoreIntent(original, template, { kind: "update_visual_layer", visualLayer });

    expect(result.bundle.visualLayer).toEqual(visualLayer);
    expect(result.bundle.routes).toEqual(original.routes);
    expect(result.bundle.assets).toEqual(original.assets);
  });

  it("fails closed when the protected hero or route contract has drifted", () => {
    const missingHero = bundle();
    missingHero.assets.entries = [];
    expect(() => applyStoreIntent(missingHero, template, {
      kind: "update_text",
      slot: "heroTitle",
      value: "Summer starts here",
    })).toThrowError(expect.objectContaining({ code: "storefront_template_integrity_failed" }));

    const missingRoute = bundle() as StorefrontBundleV1 & { routes: Partial<StorefrontBundleV1["routes"]> };
    Reflect.deleteProperty(missingRoute.routes, "checkout");
    expect(() => applyStoreIntent(missingRoute as StorefrontBundleV1, template, {
      kind: "update_merchandising",
      productIds: ["product-a"],
    })).toThrowError(expect.objectContaining({ code: "storefront_template_integrity_failed" }));
  });

  it("fails closed when the supplied design record does not own the bundle", () => {
    expect(() => applyStoreIntent(bundle(), getStoreTemplate("soft-chemistry"), {
      kind: "update_merchandising",
      productIds: ["product-a"],
    })).toThrowError(expect.objectContaining({ code: "storefront_template_integrity_failed" }));
  });
});
