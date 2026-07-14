import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compileBundle } from "../storefront-compiler/compile";
import { VALID_BUNDLE_SOURCE } from "../storefront-compiler/__fixtures__/valid-bundle";
import { applyStorefrontPatch, StorefrontPatchError } from "./patch.server";
import { validateCompiledBundle } from "../storefront-compiler/validate";

const freshBundle = () => compileBundle(structuredClone(VALID_BUNDLE_SOURCE)).bundle;
const digest = (value: unknown) => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;

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

  it("compiler-validates a scoped region replacement with CSS, interactions, icons, and verified imagery", () => {
    const bundle = freshBundle();
    bundle.assets.entries = [{ key: "hero", contentHash: "a".repeat(64), mediaType: "image/webp", byteSize: 42 }];
    const target = bundle.routes.home.tree[0]!;
    if (target.kind !== "element") throw new Error("fixture root");
    const productBefore = structuredClone(bundle.routes.product);
    const result = applyStorefrontPatch(bundle, [{
      kind: "replaceRegion",
      routeId: "home",
      targetId: target.id,
      expected: digest(target),
      source: {
        html: `<main id="opening" class="opening"><img id="hero-art" class="hero-art" data-cd-asset="hero" alt="Merchant-owned hero"><button id="details" data-cd-on="click" data-cd-action="accordion.toggle" data-cd-target="panel">Details</button><section id="panel"><span id="mark" role="img" title="Spark">✦</span></section></main>`,
        css: `.opening { display:grid; grid-template-columns:2fr 1fr } .hero-art { inline-size:100% }`,
      },
    }]);

    expect(result.bundle.routes.product).toEqual(productBefore);
    expect(result.bundle.routes.home.tree[0]).toMatchObject({ kind: "element", id: expect.stringMatching(/opening$/) });
    expect(result.bundle.routes.home.interactions.transitions).toEqual([
      expect.objectContaining({ sourceId: expect.stringMatching(/details$/), action: expect.objectContaining({ type: "accordion.toggle", targetId: expect.stringMatching(/panel$/) }) }),
    ]);
    const replacement = result.bundle.routes.home.tree[0];
    if (replacement.kind !== "element") throw new Error("fixture root");
    expect(result.bundle.routes.home.css).toContain(`[data-cd-bundle=home] .opening#${replacement.id}`);
    expect(JSON.stringify(result.bundle.routes.home.tree)).toContain('"data-cd-asset-key":"hero"');
    expect(result.changedScope).toMatchObject({ routes: ["home"], regions: [`home:${target.id}`] });
    expect(result.structural).toBe(true);
    expect(validateCompiledBundle(result.bundle)).toMatchObject({ ok: true, diagnostics: [] });
  });

  it("roots replacement CSS at the exact replacement compiler ID and rejects sibling escapes", () => {
    const bundle = freshBundle();
    const target = bundle.routes.home.tree[0]!;
    if (target.kind !== "element") throw new Error("fixture root");

    expect(() => applyStorefrontPatch(bundle, [{
      kind: "replaceRegion",
      routeId: "home",
      targetId: target.id,
      expected: digest(target),
      source: {
        html: `<main id="opening" class="opening"><p class="copy">Safe</p></main>`,
        css: `.opening + .unrelated { display:none }`,
      },
    }])).toThrowError(/scope|sibling|region/i);
  });

  it("requires exact subtree hashes for AI-authored element operations", () => {
    const bundle = freshBundle();
    const target = bundle.routes.home.tree[0]!;
    if (target.kind !== "element") throw new Error("fixture root");

    expect(() => applyStorefrontPatch(bundle, [{
      kind: "replaceTextChildren", routeId: "home", targetId: target.id, value: "Changed",
      expected: `sha256:${"0".repeat(64)}`,
    }])).toThrowError(/changed before this edit/);
    expect(() => applyStorefrontPatch(bundle, [{
      kind: "setVisibility", routeId: "home", targetId: target.id, hidden: true,
      expected: `sha256:${"0".repeat(64)}`,
    }])).toThrowError(/changed before this edit/);
  });

  it("rejects stale structural preconditions and asset references outside the verified manifest", () => {
    const bundle = freshBundle();
    const target = bundle.routes.home.tree[0]!;
    if (target.kind !== "element") throw new Error("fixture root");
    expect(() => applyStorefrontPatch(bundle, [{
      kind: "replaceRegion", routeId: "home", targetId: target.id, expected: `sha256:${"0".repeat(64)}`,
      source: { html: `<main id="opening">New</main>`, css: `.opening { display:block }` },
    }])).toThrowError(/changed before this edit/);
    expect(() => applyStorefrontPatch(bundle, [{
      kind: "replaceRegion", routeId: "home", targetId: target.id, expected: digest(target),
      source: { html: `<main id="opening"><img data-cd-asset="invented" alt="No"></main>`, css: `.opening { display:block }` },
    }])).toThrowError(/verified asset manifest/);
  });

  it("keeps item-scoped home quick view data on the featured-product plan", () => {
    const bundle = freshBundle();
    const target = bundle.routes.home.tree[0]!;
    if (target.kind !== "element") throw new Error("fixture root");
    const result = applyStorefrontPatch(bundle, [{
      kind: "replaceRegion",
      routeId: "home",
      targetId: target.id,
      expected: digest(target),
      source: {
        html: `<main><section data-cd-repeat="featured.products"><article data-cd-key="product.id"><h2 data-cd-text="product.title"></h2><div data-cd-slot="quickViewCommerce" data-cd-product="product.id" data-cd-host-size="inline"></div></article></section></main>`,
        css: ``,
      },
    }]);

    expect(result.bundle.routes.home.requiredData).toContainEqual({ kind: "featuredProducts", limit: 12 });
    expect(result.bundle.routes.home.requiredData).not.toContainEqual({ kind: "currentProduct" });
  });

  it("replaces route-scoped CSS only after an exact precondition and rejects executable or escaping CSS", () => {
    const bundle = freshBundle();
    const prior = bundle.routes.home.css;
    const result = applyStorefrontPatch(bundle, [{
      kind: "replaceRouteCss",
      routeId: "home",
      expected: digest(prior),
      css: `main { display:grid; container-type:inline-size } @media (min-width: 40rem) { main { grid-template-columns:1fr 2fr } }`,
    }]);
    expect(result.bundle.routes.home.css).not.toBe(prior);
    expect(result.bundle.routes.product.css).toBe(bundle.routes.product.css);
    expect(result.changedScope).toMatchObject({ routes: ["home"], css: ["home"] });
    expect(validateCompiledBundle(result.bundle)).toMatchObject({ ok: true, diagnostics: [] });
    expect(() => applyStorefrontPatch(bundle, [{
      kind: "replaceRouteCss", routeId: "home", expected: digest(prior), css: `body { background:url(javascript:alert(1)) }`,
    }])).toThrow();
  });
});
