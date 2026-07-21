import { describe, expect, it } from "vitest";
import { compileHtml } from "./html";

describe("binding and repeat scopes", () => {
  it("compiles merchant collection discovery into collection scopes", () => {
    const result = compileHtml(
      `<section data-cd-repeat="featured.collections"><a data-cd-key="collection.id" data-cd-route="collection" data-cd-param-handle="collection.handle"><span data-cd-text="collection.title"></span></a></section>`,
      { namespace: "collections", rootScopeKind: "store" },
    );

    expect(result.repeats[0]).toMatchObject({
      source: "featured.collections",
      itemKind: "collection",
      keyPath: "collection.id",
    });
  });

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

  it("allows the public cart count in the root store shell without exposing cart lines", () => {
    const result = compileHtml(`<a data-cd-route="cart">Bag <span data-cd-text="cart.count"></span></a>`, {
      namespace: "shell",
      rootScopeKind: "store",
    });

    expect(result.bindings).toContainEqual(expect.objectContaining({
      ref: { kind: "data", scopeId: "root", path: "cart.count" },
    }));
    expect(compileHtml(`<span data-cd-text="cart.count"></span>`, {
      namespace: "cart",
      rootScopeKind: "cart",
    }).bindings).toContainEqual(expect.objectContaining({
      ref: { kind: "data", scopeId: "root", path: "cart.count" },
    }));
    expect(() => compileHtml(`<span data-cd-money="cart.total"></span>`, {
      namespace: "shell",
      rootScopeKind: "store",
    })).toThrow(/scope/i);
  });

  it("rejects unresolved and private binding paths", () => {
    expect(() =>
      compileHtml(`<section data-cd-text="product.shop_id"></section>`, { namespace: "product" }),
    ).toThrow(/binding/i);
  });

  it("allows only closed public facts inside the product facts scope", () => {
    const result = compileHtml(
      `<dl data-cd-repeat="product.facts"><div data-cd-key="fact.id"><dt data-cd-text="fact.label"></dt><dd data-cd-text="fact.value"></dd><a data-cd-href="fact.url">Document</a></div></dl>`,
      { namespace: "product", rootScopeKind: "product" },
    );
    expect(result.repeats[0]).toMatchObject({ source: "product.facts", itemKind: "fact", keyPath: "fact.id" });
    expect(result.bindings.map(({ ref }) => ref.kind === "data" ? ref.path : null)).toEqual(["fact.label", "fact.value", "fact.url"]);
    expect(() => compileHtml(`<span data-cd-text="product.metafields"></span>`, { namespace: "product", rootScopeKind: "product" })).toThrow(/unsupported/i);
    expect(() => compileHtml(`<span data-cd-text="fact.value"></span>`, { namespace: "product", rootScopeKind: "product" })).toThrow(/scope/i);
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
