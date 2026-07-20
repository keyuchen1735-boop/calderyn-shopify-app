import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { CompiledNode, RouteArtifact } from "~/lib/storefront-bundle/types";

const repeats = (nodes: readonly CompiledNode[]): string[] => nodes.flatMap((node) =>
  node.kind === "text" ? [] : [...(node.repeat ? [node.repeat.source] : []), ...repeats(node.children)]
);
const actions = (route: RouteArtifact) => route.interactions.transitions.map((transition) => transition.action.type);
const dataPaths = (route: RouteArtifact) => route.bindings.flatMap(({ ref }) => ref.kind === "data" ? [ref.path] : []);

describe("Forge storefront recipe", () => {
  it("compiles a nine-route jobsite blueprint from live merchant facts", async () => {
    const module = await import("./bundle").catch(() => null);
    expect(module, "Forge recipe source must exist").not.toBeNull();
    if (!module) return;

    const { FORGE_RECIPE, FORGE_RECIPE_CONFIG } = module;
    const { bundle, config } = FORGE_RECIPE;

    expect(config).toMatchObject({
      templateId: FORGE_RECIPE_CONFIG.templateId,
      templateVersion: FORGE_RECIPE_CONFIG.templateVersion,
      concept: FORGE_RECIPE_CONFIG.concept,
    });
    expect(bundle.source).toEqual({ kind: "recipe", templateId: "forge", templateVersion: 1 });
    expect(config.archetype).toMatchObject({
      composition: "jobsite-blueprint",
      hero: "exploded-tool-hero",
      scroll: "blueprint-flow",
      cards: "tool-diagrams",
    });
    expect(Object.keys(bundle.routes)).toEqual([
      "home", "collection", "product", "search", "cart", "checkout", "collections", "story", "notFound",
    ]);
    expect(new Set(Object.values(config.surfaces).map((surface) => surface.signature)).size).toBe(10);

    expect(bundle.designSystem).toMatchObject({ displayFontId: "oswald", bodyFontId: "dm-mono" });
    expect(bundle.designSystem.tokens).toMatchObject({ steel: "#24313a", orange: "#c94f18", parchment: "#efe4ce" });
    expect(bundle.shell.trustedSlots.map((slot) => slot.kind)).toContain("cartDrawer");
    for (const route of ["home", "collections", "collection", "story", "search", "cart"] as const) {
      expect(config.surfaces.shell.source.html).toContain(`data-cd-route="${route}"`);
    }

    expect(repeats(bundle.routes.home.tree)).toContain("featured.products");
    expect(dataPaths(bundle.routes.home)).toEqual(expect.arrayContaining([
      "product.primaryImage", "product.title", "product.description", "product.price", "product.availability",
    ]));
    expect(bundle.routes.home.html).toContain("Add verified items one at a time");
    expect(bundle.routes.home.trustedSlots.map((slot) => slot.kind)).toContain("quickViewCommerce");

    expect(repeats(bundle.routes.collection.tree)).toContain("collection.products");
    expect(actions(bundle.routes.collection)).toEqual(expect.arrayContaining(["collection.filter", "collection.sort"]));
    expect(bundle.routes.collection.interactions.transitions.filter((item) => item.action.type === "collection.filter"))
      .toSatisfy((items: RouteArtifact["interactions"]["transitions"]) => items.length >= 4);
    expect(bundle.routes.collection.html).toContain("Merchant-supplied project tags");
    expect(dataPaths(bundle.routes.collection)).toEqual(expect.arrayContaining([
      "collection.title", "collection.description", "product.primaryImage", "product.title", "product.description",
      "product.price", "product.availability",
    ]));
    expect(bundle.routes.collection.trustedSlots.map((slot) => slot.kind)).toContain("quickViewCommerce");

    expect(repeats(bundle.routes.product.tree)).toEqual(expect.arrayContaining(["product.images", "product.variants"]));
    expect(dataPaths(bundle.routes.product)).toEqual(expect.arrayContaining([
      "product.primaryImage", "product.title", "product.description", "product.price", "product.availability",
      "variant.title", "variant.price", "variant.availability",
    ]));
    expect(bundle.routes.product.html).toContain("Merchant compatibility record");
    expect(bundle.routes.product.trustedSlots.map((slot) => slot.kind)).toEqual(
      expect.arrayContaining(["variantPicker", "addToCart"]),
    );

    const routeMarkup = Object.values(bundle.routes)
      .map((route) => "html" in route ? route.html : route.decorativeHtml)
      .join(" ");
    expect(routeMarkup.toLowerCase()).not.toContain("download");
    expect(routeMarkup).not.toMatch(/href=["'][^"']+\.pdf/i);
    expect(routeMarkup).not.toMatch(/\b(?:ansi|osha|ip\d\d|\d+\s*(?:nm|rpm|psi))\b/i);

    expect(repeats(bundle.routes.search.tree)).toContain("search.results");
    expect(actions(bundle.routes.search)).toEqual(expect.arrayContaining(["search.update", "search.submit", "search.clear"]));
    expect(repeats(bundle.routes.cart.tree)).toContain("cart.lines");
    expect(bundle.routes.cart.trustedSlots.map((slot) => slot.kind)).toEqual(
      expect.arrayContaining(["cartLineControls", "cartSummary"]),
    );
  });

  it("fails media closed while preserving exactly three trusted video roles", async () => {
    const module = await import("./bundle").catch(() => null);
    const assetsModule = await import("./assets").catch(() => null);
    expect(module).not.toBeNull();
    expect(assetsModule).not.toBeNull();
    if (!module || !assetsModule) return;

    const { FORGE_RECIPE } = module;
    const { FORGE_ASSETS, FORGE_VIDEO_ROLES } = assetsModule;
    expect(FORGE_VIDEO_ROLES).toEqual(["hero", "hero-alt", "pdp-detail"]);
    expect(FORGE_ASSETS).toEqual({ entries: [] });
    expect(FORGE_RECIPE.report.ok).toBe(false);
    expect(FORGE_RECIPE.report.diagnostics).toHaveLength(18);
    expect([...new Set(FORGE_RECIPE.report.diagnostics.map((diagnostic) => diagnostic.code))])
      .toEqual(["asset.media_mismatch", "asset.reference_missing"]);
    expect(FORGE_RECIPE.report.diagnostics.filter((diagnostic) => diagnostic.code === "asset.media_mismatch"))
      .toHaveLength(9);
    expect(FORGE_RECIPE.report.diagnostics.filter((diagnostic) => diagnostic.code === "asset.reference_missing"))
      .toHaveLength(9);

    const videoMarkup = Object.values(FORGE_RECIPE.config.surfaces)
      .map((surface) => surface.source.html)
      .join(" ");
    for (const role of FORGE_VIDEO_ROLES) {
      expect(videoMarkup).toContain(`data-cd-poster-asset="${role}-poster"`);
      expect(videoMarkup).toContain(`data-cd-asset="${role}-webm"`);
      expect(videoMarkup).toContain(`data-cd-asset="${role}-mp4"`);
    }
    expect(videoMarkup.match(/data-cd-video/g)).toHaveLength(3);
    expect(FORGE_RECIPE.bundle.designSystem.globalCss).toContain("prefers-reduced-motion");
  });

  it("ships a self-contained static blueprint prototype and exactly three briefs", () => {
    const prototypePath = resolve(process.cwd(), "docs/superpowers/prototypes/storefront-recipes/forge.html");
    const briefPath = resolve(process.cwd(), "app/lib/storefront-recipes/forge/video-brief.md");
    const prototype = readFileSync(prototypePath, "utf8");
    const brief = readFileSync(briefPath, "utf8");

    expect(prototype).toContain("<!doctype html>");
    expect(prototype).toContain("Merchant compatibility record");
    expect(prototype).toContain("Merchant-supplied project tags");
    expect(prototype).not.toMatch(/https?:\/\//);
    expect(brief.match(/^## Video brief:/gm)).toHaveLength(3);
  });
});
