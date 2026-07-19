import { describe, expect, it } from "vitest";
import type { CompiledNode, RouteArtifact } from "~/lib/storefront-bundle/types";
import { ROOM_MODES_ASSETS } from "./assets";
import { ROOM_MODES_RECIPE } from "./bundle";

function repeatsIn(nodes: readonly CompiledNode[]): string[] {
  return nodes.flatMap((node) => node.kind === "text"
    ? []
    : [...(node.repeat ? [node.repeat.source] : []), ...repeatsIn(node.children)]);
}

function actionsIn(route: RouteArtifact): string[] {
  return route.interactions.transitions.map((transition) => transition.action.type);
}

describe("room-modes storefront recipe", () => {
  it("keeps the original viewport room-scene geometry", () => {
    expect(ROOM_MODES_RECIPE.bundle.routes.home.css).toContain("min-height:100dvh");
  });

  it("renders live availability in object search results", () => {
    expect(ROOM_MODES_RECIPE.bundle.routes.search.bindings.map((binding) => binding.ref.kind === "data" ? binding.ref.path : null)).toContain("product.availability");
  });

  it("compiles the approved spatial scene system across every commerce route", () => {
    const { bundle, config, report } = ROOM_MODES_RECIPE;

    expect(report).toMatchObject({ profileVersion: 1, ok: true, diagnostics: [] });
    expect(bundle.source).toEqual({ kind: "recipe", templateId: "room-modes", templateVersion: 3 });
    expect(config.archetype).toEqual({
      composition: "spatial-scenes",
      hero: "room-mode-scene",
      scroll: "spatial-snap",
      cards: "scene-panels",
      iconography: ["architectural plan symbols", "device protocol marks"],
    });
    expect(bundle.designSystem).toMatchObject({
      displayFontId: "space-grotesk",
      bodyFontId: "ibm-plex-mono",
      iconStyle: "architectural plan marks and protocol indicators",
      motionStyle: "vertical scene snap with reduced-motion linear fallback",
    });
    expect(new Set(Object.values(config.surfaces).map((surface) => surface.signature)).size).toBe(7);

    expect(ROOM_MODES_ASSETS.entries).toEqual([
      expect.objectContaining({ key: "hero", mediaType: "image/webp", byteSize: 80050 }),
    ]);
    expect(bundle.assets).toEqual(ROOM_MODES_ASSETS);
    expect(bundle.routes.home.html).toContain('data-cd-asset-key="hero"');
    expect(bundle.routes.home.html).toContain("Scene view");
    expect(bundle.routes.home.html).toContain("Object index");

    expect(bundle.shell.bindings.map((binding) => binding.ref)).toContainEqual(
      expect.objectContaining({ kind: "data", path: "store.name" }),
    );
    expect(bundle.shell.trustedSlots.map((slot) => slot.kind)).toContain("cartDrawer");
    expect(repeatsIn(bundle.routes.home.tree)).toContain("featured.products");
    expect(repeatsIn(bundle.routes.collection.tree)).toContain("collection.products");
    expect(actionsIn(bundle.routes.collection)).toEqual(expect.arrayContaining(["collection.filter", "collection.sort"]));
    expect(bundle.routes.collection.trustedSlots.map((slot) => slot.kind)).toContain("quickViewCommerce");

    expect(repeatsIn(bundle.routes.product.tree)).toEqual(expect.arrayContaining(["product.images", "product.variants"]));
    expect(bundle.routes.product.bindings.map((binding) => binding.ref.kind === "data" ? binding.ref.path : null)).toEqual(
      expect.arrayContaining(["product.title", "product.description", "product.price", "product.availability"]),
    );
    expect(bundle.routes.product.trustedSlots.map((slot) => slot.kind)).toEqual(
      expect.arrayContaining(["variantPicker", "addToCart"]),
    );

    expect(repeatsIn(bundle.routes.search.tree)).toContain("search.results");
    expect(actionsIn(bundle.routes.search)).toEqual(expect.arrayContaining(["search.submit", "search.clear"]));
    expect(repeatsIn(bundle.routes.cart.tree)).toContain("cart.lines");
    expect(bundle.routes.cart.trustedSlots.map((slot) => slot.kind)).toEqual(
      expect.arrayContaining(["cartLineControls", "cartSummary"]),
    );
    expect(bundle.routes.checkout.layout).toEqual({
      columnMode: "summaryAside",
      sectionOrder: ["contact", "shipping", "delivery", "consent", "payment", "summary"],
      spacingTokenId: "space-room",
      surfaceTokenIds: ["chalk", "smoke", "amber"],
    });

    const routeText = Object.values(bundle.routes).map((route) => "html" in route ? route.html : route.decorativeHtml).join(" ");
    expect(routeText).toContain("No objects match this room mode");
    expect(routeText).toContain("Sold out");
    expect(Object.values(bundle.routes).filter((route): route is RouteArtifact => "html" in route).every((route) => route.css.includes("overflow-wrap:anywhere"))).toBe(true);
    expect(routeText).not.toMatch(/https?:\/\//);
  });
});
