import { describe, expect, it } from "vitest";
import { compileHtml } from "./html";

describe("binding and repeat scopes", () => {
  it("compiles an allowlisted repeater into a local scope", () => {
    const result = compileHtml(
      `<ul data-cd-repeat="collection.products"><li data-cd-key="product.id"><span data-cd-text="product.title"></span></li></ul>`,
      { namespace: "collection", rootScopeKind: "collection" },
    );

    expect(result.repeats).toEqual([
      expect.objectContaining({ source: "collection.products", itemKind: "product" }),
    ]);
    expect(result.bindings).toEqual([
      expect.objectContaining({
        ref: expect.objectContaining({ path: "product.title", scopeId: result.repeats[0]?.scopeId }),
      }),
    ]);
  });

  it("rejects a binding outside its repeat scope", () => {
    expect(() =>
      compileHtml(`<section data-cd-text="product.title"></section>`, { namespace: "home" }),
    ).toThrow(/scope/i);
  });

  it("rejects unresolved and private binding paths", () => {
    expect(() =>
      compileHtml(`<section data-cd-text="product.shop_id"></section>`, { namespace: "product" }),
    ).toThrow(/binding/i);
  });

  it("rejects type-confused bindings and repeat sources outside their parent scope", () => {
    expect(() =>
      compileHtml(`<span data-cd-money="product.title"></span>`, {
        namespace: "product",
        rootScopeKind: "product",
      }),
    ).toThrow(/money/i);
    expect(() =>
      compileHtml(`<div data-cd-repeat="cart.lines"></div>`, {
        namespace: "home",
        rootScopeKind: "store",
      }),
    ).toThrow(/scope/i);
  });

  it("validates internal route targets instead of accepting literal storefront URLs", () => {
    const result = compileHtml(
      `<div data-cd-repeat="collection.products"><a data-cd-key="product.id" data-cd-route="product" data-cd-param-handle="product.handle">View</a></div>`,
      { namespace: "collection", rootScopeKind: "collection" },
    );
    expect(result.routeTargets[0]).toEqual(
      expect.objectContaining({ routeId: "product", params: { handle: expect.any(Object) } }),
    );
    expect(() => compileHtml(`<a href="/storefront/products/x">bad</a>`, { namespace: "x" })).toThrow(
      /href/i,
    );
  });
});
