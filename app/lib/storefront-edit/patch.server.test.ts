import { describe, expect, it } from "vitest";
import { compileBundle } from "../storefront-compiler/compile";
import { VALID_BUNDLE_SOURCE } from "../storefront-compiler/__fixtures__/valid-bundle";
import { applyStorefrontPatch, StorefrontPatchError } from "./patch.server";
import { validateCompiledBundle } from "../storefront-compiler/validate";

const freshBundle = () => compileBundle(structuredClone(VALID_BUNDLE_SOURCE)).bundle;

describe("applyStorefrontPatch", () => {
  it("applies typed token/font/text/visibility operations with preconditions", () => {
    const bundle = freshBundle();
    const titleId = bundle.routes.home.bindings[0]!.targetId;
    const result = applyStorefrontPatch(bundle, [
      { kind: "setToken", tokenId: "ink", value: "#223344", expected: "#111111" },
      { kind: "setFont", target: "display", fontId: "space-grotesk", expected: "fraunces" },
      { kind: "setText", routeId: "home", targetId: titleId, value: "New season" },
      { kind: "setVisibility", routeId: "home", targetId: titleId, hidden: true },
    ]);
    expect(result.bundle.designSystem.tokens.ink).toBe("#223344");
    expect(result.bundle.designSystem.displayFontId).toBe("space-grotesk");
    expect(JSON.stringify(result.bundle.routes.home.tree)).toContain("New season");
    expect(JSON.stringify(result.bundle.routes.home.tree)).toContain("storefront-edit-hidden");
    expect(result.changedRoutes).toEqual(["home"]);
    expect(bundle.designSystem.tokens.ink).toBe("#111111");
    expect(validateCompiledBundle(result.bundle)).toMatchObject({ ok: true, diagnostics: [] });
  });

  it("rejects stale preconditions and invalid compiler IDs before mutation", () => {
    expect(() => applyStorefrontPatch(freshBundle(), [
      { kind: "setToken", tokenId: "ink", value: "#223344", expected: "#000000" },
    ])).toThrowError(new StorefrontPatchError("patch_precondition_failed", "Token ink changed before this edit"));
    expect(() => applyStorefrontPatch(freshBundle(), [
      { kind: "setText", routeId: "home", targetId: "not-issued", value: "x" },
    ])).toThrowError(/compiler-issued target/);
  });

  it("reorders only the named parent and preserves every untouched route", () => {
    const bundle = freshBundle();
    const homeBefore = structuredClone(bundle.routes.home);
    const productBefore = structuredClone(bundle.routes.product);
    const root = bundle.routes.home.tree[0]!;
    if (root.kind !== "element") throw new Error("fixture root");
    const result = applyStorefrontPatch(bundle, [{
      kind: "reorderChildren",
      routeId: "home",
      parentId: root.id,
      childIds: root.children.filter((node) => node.kind === "element").map((node) => node.id).reverse(),
    }]);
    expect(result.bundle.routes.product).toEqual(productBefore);
    expect(bundle.routes.home).toEqual(homeBefore);
  });
});
