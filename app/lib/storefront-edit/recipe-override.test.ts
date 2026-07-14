import { describe, expect, it } from "vitest";
import { compileBundle } from "../storefront-compiler/compile";
import { VALID_BUNDLE_SOURCE } from "../storefront-compiler/__fixtures__/valid-bundle";
import { patchFitsRecipeOverride } from "./recipe-override";
import type { StorefrontPatchOperation } from "./types";

function recipeBundle() {
  const bundle = compileBundle(structuredClone(VALID_BUNDLE_SOURCE)).bundle;
  bundle.source = { kind: "recipe", templateId: "atelier-nine", templateVersion: 1 };
  return bundle;
}

describe("patchFitsRecipeOverride", () => {
  it("maps compiler IDs to the declared semantic token, text, optional, and reorder surfaces", () => {
    const bundle = recipeBundle();
    const root = bundle.routes.home.tree[0]!;
    if (root.kind !== "element") throw new Error("fixture root");
    root.children.push(
      { kind: "element", id: "cd-home-hero-title", tag: "h1", attributes: {}, children: [{ kind: "text", value: "Hero" }] },
      { kind: "element", id: "cd-home-newsletter", tag: "section", attributes: { class: "newsletter" }, children: [] },
      { kind: "element", id: "cd-home-social-proof", tag: "section", attributes: { class: "social-proof" }, children: [] },
      { kind: "element", id: "cd-home-featured-collection", tag: "section", attributes: { class: "featured-collection" }, children: [] },
      { kind: "element", id: "cd-home-editorial-story", tag: "section", attributes: { class: "editorial-story" }, children: [] },
    );
    expect(patchFitsRecipeOverride(bundle, [
      { kind: "setToken", tokenId: "ink", value: "#223344" },
      { kind: "setFont", target: "display", fontId: "space-grotesk" },
      { kind: "setText", routeId: "home", targetId: "cd-home-hero-title", value: "A new title" },
      { kind: "setVisibility", routeId: "home", targetId: "cd-home-newsletter", hidden: true },
      { kind: "moveRegion", routeId: "home", targetId: "cd-home-social-proof", direction: "up" },
      {
        kind: "reorderChildren", routeId: "home", parentId: "cd-home-sections",
        childIds: ["cd-home-featured-collection", "cd-home-editorial-story", "cd-home-newsletter"],
      },
    ])).toBe(true);
  });

  it("maps a compiler-generated home h1 ID to the heroTitle semantic slot", () => {
    const bundle = recipeBundle();
    const findHeading = (nodes: typeof bundle.routes.home.tree): string | null => {
      for (const node of nodes) {
        if (node.kind !== "element") continue;
        if (node.tag === "h1") return node.id;
        const nested = findHeading(node.children);
        if (nested) return nested;
      }
      return null;
    };
    const targetId = findHeading(bundle.routes.home.tree);
    if (!targetId) throw new Error("fixture heading");
    expect(patchFitsRecipeOverride(bundle, [
      { kind: "setText", routeId: "home", targetId, value: "Mapped semantic title" },
    ])).toBe(true);
  });

  it.each<StorefrontPatchOperation>([
    { kind: "setText", routeId: "home", targetId: "cd-home-legal-disclaimer", value: "Changed" },
    { kind: "setVisibility", routeId: "home", targetId: "cd-home-purchase-grid", hidden: true },
    { kind: "moveRegion", routeId: "home", targetId: "cd-home-purchase-grid", direction: "down" },
    { kind: "reorderChildren", routeId: "home", parentId: "cd-home-sections", childIds: ["cd-home-purchase-grid"] },
  ])("detaches non-allowlisted recipe operation $kind", (operation) => {
    expect(patchFitsRecipeOverride(recipeBundle(), [operation])).toBe(false);
  });
});
