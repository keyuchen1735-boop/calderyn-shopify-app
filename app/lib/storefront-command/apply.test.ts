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

    expect(result.bundle.routes.home.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).toContain("Summer starts here");
    expect(result.bundle.routes.home.html).not.toContain("made real");
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

  it("rejects a section heading when multiple concrete candidates exist", () => {
    const original = bundle();
    expect(() => applyStoreIntent(original, template, {
      kind: "update_text",
      slot: "sectionHeading",
      value: "Made for long weekends",
    })).toThrowError(expect.objectContaining({ code: "storefront_template_integrity_failed" }));

    expect(original.routes.home.html).not.toContain("Made for long weekends");
    expect(original.routes.home.html).toContain("Start with an object");
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

  it("applies every text slot advertised by every design", () => {
    for (const recipe of STOREFRONT_RECIPES) {
      const activeTemplate = getStoreTemplate(recipe.config.templateId);
      for (const slot of activeTemplate.overrideSurface.textSlots) {
        const key = `${recipe.config.templateId}:${slot}`;
        let result: ReturnType<typeof applyStoreIntent>;
        try {
          result = applyStoreIntent(recipe.bundle, activeTemplate, {
            kind: "update_text",
            slot,
            value: "Replacement copy",
          });
        } catch (error) {
          throw new Error(`${key} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        const renderedText = `${result.bundle.shell.html} ${result.bundle.routes.home.html}`
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ");
        expect(renderedText, key).toContain("Replacement copy");
        expect(result.bundle.assets, key).toEqual(recipe.bundle.assets);
        expect(result.bundle.routes.home.css, key).toBe(recipe.bundle.routes.home.css);
        expect(result.bundle.routes.home.interactions, key).toEqual(recipe.bundle.routes.home.interactions);
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

  it("fails closed instead of choosing the first ambiguous text fallback", () => {
    const ambiguous = bundle();
    const root = ambiguous.routes.home.tree.find((node) => node.kind === "element" && node.tag === "main");
    if (!root || root.kind !== "element") throw new Error("Missing home root");
    const hero = root.children.find((node) => node.kind === "element" && node.tag === "section");
    if (!hero || hero.kind !== "element") throw new Error("Missing home hero");
    const boundTitle = hero.children
      .flatMap((node) => node.kind === "element" ? node.children : [])
      .flatMap((node) => node.kind === "element" ? node.children : [])
      .find((node) => node.kind === "element" && node.tag === "h1");
    if (!boundTitle || boundTitle.kind !== "element") throw new Error("Missing bound home title");
    boundTitle.id = "unbound-title";
    hero.children.push(
      {
        kind: "element",
        id: "ambiguous-title-one",
        tag: "h1",
        attributes: {},
        children: [{ kind: "text", value: "First" }],
      },
      {
        kind: "element",
        id: "ambiguous-title-two",
        tag: "h1",
        attributes: {},
        children: [{ kind: "text", value: "Second" }],
      },
    );

    expect(() => applyStoreIntent(ambiguous, template, {
      kind: "update_text",
      slot: "heroTitle",
      value: "Do not guess",
    })).toThrowError(expect.objectContaining({ code: "storefront_template_integrity_failed" }));
  });

  it("changes only featured product IDs across every design", () => {
    for (const recipe of STOREFRONT_RECIPES) {
      const productIds = [`next-${recipe.config.templateId}-b`, `next-${recipe.config.templateId}-a`];
      const result = applyStoreIntent(recipe.bundle, getStoreTemplate(recipe.config.templateId), {
        kind: "update_merchandising",
        productIds,
      });

      expect(result.bundle.featuredProductIds, recipe.config.templateId).toEqual(productIds);
      expect(result.bundle.routes, recipe.config.templateId).toEqual(recipe.bundle.routes);
      expect(result.bundle.assets, recipe.config.templateId).toEqual(recipe.bundle.assets);
    }
  });

  it("rejects featured IDs that collide after trimming", () => {
    expect(() => applyStoreIntent(bundle(), template, {
      kind: "update_merchandising",
      productIds: ["product-a", " product-a"],
    })).toThrowError(expect.objectContaining({ code: "storefront_template_integrity_failed" }));
  });

  it("changes only the bounded visual layer across every design", () => {
    const visualLayer = {
      kind: "fragment_shader" as const,
      source: "void main(){}",
      colors: ["#000000", "#111111", "#222222"] as [string, string, string],
    };
    for (const recipe of STOREFRONT_RECIPES) {
      const result = applyStoreIntent(recipe.bundle, getStoreTemplate(recipe.config.templateId), {
        kind: "update_visual_layer",
        visualLayer,
      });

      expect(result.bundle.visualLayer, recipe.config.templateId).toEqual(visualLayer);
      expect(result.bundle.routes, recipe.config.templateId).toEqual(recipe.bundle.routes);
      expect(result.bundle.assets, recipe.config.templateId).toEqual(recipe.bundle.assets);
    }
  });

  it("rejects padded visual-layer colors", () => {
    expect(() => applyStoreIntent(bundle(), template, {
      kind: "update_visual_layer",
      visualLayer: {
        kind: "fragment_shader",
        source: "void main(){}",
        colors: [" #000000", "#111111", "#222222"],
      },
    })).toThrowError(expect.objectContaining({ code: "storefront_template_integrity_failed" }));
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

    const unknownRoute = bundle() as StorefrontBundleV1 & { routes: StorefrontBundleV1["routes"] & Record<"unknown", StorefrontBundleV1["routes"]["home"]> };
    unknownRoute.routes.unknown = structuredClone(unknownRoute.routes.home);
    expect(() => applyStoreIntent(unknownRoute, template, {
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
