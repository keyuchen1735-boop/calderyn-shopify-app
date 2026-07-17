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

describe("storefront recipe route matrix", () => {
  it("implements exactly one validated active recipe for every registered template", () => {
    const registeredIds = STORE_TEMPLATE_REGISTRY.templates.map((template) => template.id);
    const recipeIds = STOREFRONT_RECIPES.map((recipe) => recipe.config.templateId);

    expect(recipeIds).toEqual(registeredIds);
    expect(new Set(recipeIds).size).toBe(11);
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

  it("keeps all eleven visual systems structurally distinct", () => {
    for (const identity of ["composition", "hero", "scroll", "cards"] as const) {
      expect(new Set(STOREFRONT_RECIPES.map((recipe) => recipe.config.archetype[identity])).size).toBe(11);
    }
    expect(new Set(STOREFRONT_RECIPES.map((recipe) => recipe.bundle.designSystem.iconStyle)).size).toBe(11);
    expect(new Set(STOREFRONT_RECIPES.map((recipe) => recipe.bundle.designSystem.motionStyle)).size).toBe(11);
    expect(new Set(STOREFRONT_RECIPES.map((recipe) =>
      `${recipe.bundle.designSystem.displayFontId}/${recipe.bundle.designSystem.bodyFontId}`,
    )).size).toBeGreaterThanOrEqual(8);
    expect(new Set(STOREFRONT_RECIPES.map((recipe) => [
      recipe.bundle.designSystem.globalCss,
      recipe.bundle.shell.css,
      ...ROUTES.map((routeId) => recipe.bundle.routes[routeId].css),
      recipe.bundle.routes.checkout.decorativeCss,
    ].join("\n"))).size).toBe(11);
    expect(new Set(STOREFRONT_RECIPES.flatMap((recipe) =>
      Object.values(recipe.config.surfaces).map((surface) => surface.signature),
    )).size).toBe(77);
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

  it("ships each declared hero from an owned, hash-verified static path", () => {
    for (const { bundle, config } of STOREFRONT_RECIPES) {
      expect(bundle.assets.entries).toHaveLength(1);
      const asset = bundle.assets.entries[0];
      expect(asset).toMatchObject({ key: "hero", mediaType: "image/webp" });
      const assetPath = path.join(ROOT, "public", "storefront-recipes", config.templateId, `${asset.key}.webp`);
      expect(existsSync(assetPath)).toBe(true);
      expect(statSync(assetPath).size).toBe(asset.byteSize);
      expect(createHash("sha256").update(readFileSync(assetPath)).digest("hex")).toBe(asset.contentHash);
      expect(bundle.routes.home.html).toContain('data-cd-asset-key="hero"');
      expect(JSON.stringify(bundle)).not.toMatch(/https?:\/\/|url\s*\(/i);

      const previewPath = path.join(ROOT, "public", STORE_TEMPLATE_REGISTRY.templates.find(
        (template) => template.id === config.templateId,
      )!.previewSrc.replace(/^\//, ""));
      expect(existsSync(previewPath)).toBe(true);
    }
  });
});
