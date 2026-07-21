import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RouteArtifact } from "../storefront-bundle/types";
import { STORE_TEMPLATE_REGISTRY } from "../storefront-bundle/registry";
import { STOREFRONT_RECIPES, STOREFRONT_RECIPE_BY_ID } from ".";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ROUTES = ["home", "collection", "product", "search", "cart"] as const;
const PRODUCT_ROUTES = ["home", "collection", "product", "search"] as const;
const LIGHT_RECIPE_CONTRACTS = {
  volt: { font: "chakra-petch", colors: ["#e9f3f2", "#102b35", "#a5dd1f"], scroll: "signal-scan" },
  atelier: { font: "young-serif", colors: ["#f3e9dc", "#31201e", "#b72b34"], scroll: "fabric-curtain" },
  gilt: { font: "cormorant-garamond", colors: ["#f8f0df", "#38271d", "#c79421"], scroll: "jewelry-orbit" },
  ember: { font: "archivo-black", colors: ["#f4e4d2", "#29120d", "#b63218"], scroll: "heat-shear" },
  roast: { font: "fraunces", colors: ["#f2e7d3", "#382116", "#b53b28"], scroll: "origin-stack" },
  fizz: { font: "syne", colors: ["#fff4ae", "#173176", "#f24877"], scroll: "flavor-buoyancy" },
  forge: { font: "barlow-condensed", colors: ["#eceae3", "#202426", "#a63a1e"], scroll: "tool-conveyor" },
  haven: { font: "newsreader", colors: ["#eef1e7", "#254437", "#c88163"], scroll: "room-wipe" },
  glow: { font: "source-serif-4", colors: ["#fbf7ef", "#23483c", "#9dcdb3"], scroll: "formula-morph" },
} as const;

function dataPaths(route: RouteArtifact): string[] {
  return route.bindings.flatMap((binding) => binding.ref.kind === "data" ? [binding.ref.path] : []);
}

function slotKinds(route: RouteArtifact): string[] {
  return route.trustedSlots.map((slot) => slot.kind);
}

function visibleText(nodes: RouteArtifact["tree"]): string {
  return nodes.map((node) => node.kind === "text" ? node.value : visibleText(node.children)).join(" ");
}

function emptyStateCount(nodes: RouteArtifact["tree"]): number {
  return nodes.reduce((count, node) => node.kind === "text"
    ? count
    : count + Number(node.attributes["data-cd-empty-state"] !== undefined) + emptyStateCount(node.children), 0);
}

function repeatSources(nodes: RouteArtifact["tree"]): string[] {
  return nodes.flatMap((node) => node.kind === "text"
    ? []
    : [...(node.repeat ? [node.repeat.source] : []), ...repeatSources(node.children)]);
}

function routeTargets(nodes: RouteArtifact["tree"]): string[] {
  return nodes.flatMap((node) => node.kind === "text"
    ? []
    : [...(node.routeTarget ? [node.routeTarget.routeId] : []), ...routeTargets(node.children)]);
}

describe("storefront recipe route matrix", () => {
  it("implements exactly one validated active recipe for every registered template", () => {
    const registeredIds = STORE_TEMPLATE_REGISTRY.templates.map((template) => template.id);
    const recipeIds = STOREFRONT_RECIPES.map((recipe) => recipe.config.templateId);

    expect(recipeIds).toEqual(registeredIds);
    expect(new Set(recipeIds).size).toBe(21);
    expect(Object.keys(STOREFRONT_RECIPE_BY_ID).sort()).toEqual([...registeredIds].sort());
    for (const recipe of STOREFRONT_RECIPES) {
      expect(recipe.report).toMatchObject({ ok: true, profileVersion: 1, diagnostics: [] });
      expect(recipe.bundle.source).toEqual({
        kind: "recipe",
        templateId: recipe.config.templateId,
        templateVersion: recipe.config.templateVersion,
      });
      expect(recipe.bundle.validationProfileVersion).toBe(1);
    }
  });

  it("keeps all visual systems structurally distinct", () => {
    for (const identity of ["composition", "hero", "scroll", "cards"] as const) {
      expect(new Set(STOREFRONT_RECIPES.map((recipe) => recipe.config.archetype[identity])).size).toBe(21);
    }
    expect(new Set(STOREFRONT_RECIPES.map((recipe) => recipe.bundle.designSystem.iconStyle)).size).toBe(21);
    expect(new Set(STOREFRONT_RECIPES.map((recipe) => recipe.bundle.designSystem.motionStyle)).size).toBe(21);
    expect(new Set(STOREFRONT_RECIPES.map((recipe) =>
      `${recipe.bundle.designSystem.displayFontId}/${recipe.bundle.designSystem.bodyFontId}`,
    )).size).toBeGreaterThanOrEqual(8);
    expect(new Set(STOREFRONT_RECIPES.map((recipe) => [
      recipe.bundle.designSystem.globalCss,
      recipe.bundle.shell.css,
      ...ROUTES.map((routeId) => recipe.bundle.routes[routeId].css),
      recipe.bundle.routes.checkout.decorativeCss,
    ].join("\n"))).size).toBe(21);
    const surfaceSignatures = STOREFRONT_RECIPES.flatMap((recipe) =>
      Object.values(recipe.config.surfaces).map((surface) => surface.signature),
    );
    expect(new Set(surfaceSignatures).size).toBe(surfaceSignatures.length);
  });

  it("covers browse, discovery, purchase, cart, and checkout with merchant-bound data", () => {
    for (const { bundle } of STOREFRONT_RECIPES) {
      expect(dataPaths(bundle.shell)).toContain("store.name");
      expect(slotKinds(bundle.shell)).toContain("cartDrawer");

      expect(bundle.routes.home.requiredData.some((plan) => plan.kind === "featuredProducts")).toBe(true);
      expect(bundle.routes.home.requiredData).not.toContainEqual({ kind: "currentProduct" });
      expect(dataPaths(bundle.routes.home)).toEqual(expect.arrayContaining(["product.title", "product.price"]));

      expect(bundle.routes.collection.requiredData).toContainEqual({ kind: "currentCollection" });
      expect(bundle.routes.collection.requiredData).not.toContainEqual({ kind: "currentProduct" });
      expect(dataPaths(bundle.routes.collection)).toEqual(expect.arrayContaining([
        "collection.title", "product.title", "product.price", "product.availability",
      ]));
      expect(bundle.routes.collection.interactions.transitions.map((transition) => transition.action.type)).toEqual(
        expect.arrayContaining(["collection.filter", "collection.sort"]),
      );
      expect(slotKinds(bundle.routes.collection)).toContain("quickViewCommerce");
      expect(bundle.routes.product.requiredData).toContainEqual({ kind: "currentProduct" });
      expect(dataPaths(bundle.routes.product)).toEqual(expect.arrayContaining([
        "product.title", "product.description", "product.price", "product.availability",
      ]));
      expect(slotKinds(bundle.routes.product)).toEqual(expect.arrayContaining(["variantPicker", "addToCart"]));

      expect(bundle.routes.search.requiredData.some((plan) => plan.kind === "searchResults")).toBe(true);
      expect(bundle.routes.search.requiredData).not.toContainEqual({ kind: "currentProduct" });
      expect(bundle.routes.search.interactions.transitions.map((transition) => transition.action.type)).toEqual(
        expect.arrayContaining(["search.submit", "search.clear"]),
      );
      expect(dataPaths(bundle.routes.search)).toEqual(expect.arrayContaining(["search.query", "product.title", "product.price"]));

      expect(bundle.routes.cart.requiredData).toContainEqual({ kind: "cart" });
      expect(bundle.routes.cart.requiredData).not.toContainEqual({ kind: "currentProduct" });
      expect(dataPaths(bundle.routes.cart)).toEqual(expect.arrayContaining([
        "cartLine.title", "cartLine.quantity", "cartLine.total",
      ]));
      expect(slotKinds(bundle.routes.cart)).toEqual(expect.arrayContaining(["cartLineControls", "cartSummary"]));

      expect(bundle.routes.checkout.layout.sectionOrder).toEqual(expect.arrayContaining([
        "contact", "shipping", "delivery", "consent", "payment", "summary",
      ]));
      expect(bundle.routes.checkout.requiredData.map((plan) => plan.kind)).toEqual(
        expect.arrayContaining(["storeIdentity", "policyLinks"]),
      );
    }
  });

  it("shows a description for every product card", () => {
    for (const { bundle, config } of STOREFRONT_RECIPES) {
      for (const routeId of PRODUCT_ROUTES) {
        const route = bundle.routes[routeId];
        const titleScopes = new Set(route.bindings.flatMap((binding) =>
          binding.kind === "text" && binding.ref.kind === "data" && binding.ref.path === "product.title"
            ? [binding.ref.scopeId]
            : [],
        ));
        const descriptionScopes = new Set(route.bindings.flatMap((binding) =>
          binding.kind === "text" && binding.ref.kind === "data" && binding.ref.path === "product.description"
            ? [binding.ref.scopeId]
            : [],
        ));

        expect([...descriptionScopes], `${config.templateId}/${routeId}`).toEqual(
          expect.arrayContaining([...titleScopes]),
        );
      }
    }
  });

  it("does not render unconditional sold-out notices below collection grids", () => {
    for (const { bundle, config } of STOREFRONT_RECIPES) {
      expect(visibleText(bundle.routes.collection.tree), config.templateId).not.toMatch(/\bsold(?:\s|\p{Pd})+out\b/iu);
    }
  });

  it("declares one conditional empty state on every catalog and cart surface", () => {
    for (const { bundle, config } of STOREFRONT_RECIPES) {
      for (const routeId of ["home", "collection", "search", "cart"] as const) {
        expect(emptyStateCount(bundle.routes[routeId].tree), `${config.templateId}/${routeId}`).toBe(1);
      }
    }
  });

  it("Taste-hardens the nine niche recipes without weakening commerce", () => {
    const ids = new Set(["volt", "atelier", "gilt", "ember", "roast", "fizz", "forge", "haven", "glow"]);
    for (const { bundle, config } of STOREFRONT_RECIPES.filter(({ config }) => ids.has(config.templateId))) {
      expect(bundle.routes.collections, config.templateId).toBeDefined();
      expect(repeatSources(bundle.routes.collections!.tree), config.templateId).toContain("featured.collections");
      expect(bundle.routes.collections!.requiredData, config.templateId).toContainEqual({ kind: "featuredCollections", limit: 12 });
      expect(bundle.routes.story, config.templateId).toBeDefined();
      expect(bundle.shell.requiredData, config.templateId).toContainEqual({ kind: "policyLinks" });
      expect(slotKinds(bundle.routes.product), config.templateId).toEqual(expect.arrayContaining(["variantPicker", "addToCart"]));
      expect(routeTargets(bundle.routes.cart.tree).some((routeId) => routeId === "collection" || routeId === "collections"), config.templateId).toBe(true);
      expect(`${visibleText(bundle.routes.home.tree)} ${visibleText(bundle.routes.story!.tree)}`, config.templateId)
        .not.toMatch(/[–—]|(?:^|\s)0[1-9]\s*(?:\/|·)/u);
    }
  });

  it("gives the nine ecommerce recipes distinct light three-color visual systems", () => {
    for (const [templateId, contract] of Object.entries(LIGHT_RECIPE_CONTRACTS)) {
      const { bundle, config } = STOREFRONT_RECIPE_BY_ID[templateId as keyof typeof LIGHT_RECIPE_CONTRACTS];
      const css = [JSON.stringify(bundle.designSystem.tokens), bundle.designSystem.globalCss, bundle.shell.css, ...Object.values(bundle.routes).flatMap((route) =>
        "css" in route ? [route.css] : [route.decorativeCss]),
      ].join("\n");
      const colors = new Set([...css.matchAll(/#[\da-f]{3,8}\b/gi)].map(([hex]) => {
        const value = hex.toLowerCase();
        return value.length === 4 ? `#${value.slice(1).split("").map((digit) => digit + digit).join("")}` : value.slice(0, 7);
      }));

      expect(bundle.designSystem.displayFontId, templateId).toBe(contract.font);
      expect(config.archetype.scroll, templateId).toBe(contract.scroll);
      expect([...colors], templateId).toEqual(expect.arrayContaining([...contract.colors]));
      expect(colors.size, templateId).toBeLessThanOrEqual(3);
      const primaryToken = Object.entries(bundle.designSystem.tokens).find(([, value]) => value === contract.colors[0])?.[0];
      expect(primaryToken, templateId).toBeDefined();
      expect(css, templateId).toMatch(new RegExp(`background(?:-color)?:${contract.colors[0]}|background(?:-color)?:var\\(--${primaryToken}\\)`, "i"));
    }
  });

  it("ships each declared asset from an owned, hash-verified static path", () => {
    for (const { bundle, config } of STOREFRONT_RECIPES) {
      if (config.templateId === "larder") {
        expect(bundle.assets.entries.map(({ key, mediaType }) => [key, mediaType])).toHaveLength(9);
        expect(bundle.assets.entries.map(({ key, mediaType }) => [key, mediaType])).toEqual(expect.arrayContaining([
          ["hero-poster", "image/webp"], ["hero-webm", "video/webm"], ["hero-mp4", "video/mp4"],
          ["hero-alt-poster", "image/webp"], ["hero-alt-webm", "video/webm"], ["hero-alt-mp4", "video/mp4"],
          ["pdp-detail-poster", "image/webp"], ["pdp-detail-webm", "video/webm"], ["pdp-detail-mp4", "video/mp4"],
        ]));
        const extension = { "image/webp": "webp", "video/webm": "webm", "video/mp4": "mp4" } as const;
        for (const asset of bundle.assets.entries) {
          const assetPath = path.join(ROOT, "public", "storefront-recipes", config.templateId, `${asset.contentHash}.${extension[asset.mediaType as keyof typeof extension]}`);
          expect(existsSync(assetPath)).toBe(true);
          expect(statSync(assetPath).size).toBe(asset.byteSize);
          expect(createHash("sha256").update(readFileSync(assetPath)).digest("hex")).toBe(asset.contentHash);
        }
        expect(bundle.routes.home.html).toContain('data-cd-poster-asset-key="hero-poster"');
      } else {
        expect(bundle.assets.entries).toEqual(expect.arrayContaining([
          expect.objectContaining({ key: "hero", mediaType: "image/webp" }),
        ]));
        for (const asset of bundle.assets.entries) {
          expect(asset.mediaType).toBe("image/webp");
          const assetPath = path.join(ROOT, "public", "storefront-recipes", config.templateId, `${asset.contentHash}.webp`);
          expect(existsSync(assetPath)).toBe(true);
          expect(statSync(assetPath).size).toBe(asset.byteSize);
          expect(createHash("sha256").update(readFileSync(assetPath)).digest("hex")).toBe(asset.contentHash);
        }
        expect(bundle.routes.home.html).toContain('data-cd-asset-key="hero"');
      }
      expect(JSON.stringify(bundle)).not.toMatch(/https?:\/\/|url\s*\(/i);

      const previewPath = path.join(ROOT, "public", STORE_TEMPLATE_REGISTRY.templates.find(
        (template) => template.id === config.templateId,
      )!.previewSrc.replace(/^\//, ""));
      expect(existsSync(previewPath)).toBe(true);
    }
  });
});
