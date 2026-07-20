import { describe, expect, it } from "vitest";
import { compileHtml } from "./html";

describe("typed interactions", () => {
  it("compiles bounded local state and state bindings with compiler-issued IDs", () => {
    const result = compileHtml(
      `<section id="drawer" data-cd-state-id="open" data-cd-state-type="boolean" data-cd-state-initial="false" data-cd-bind-state="open" data-cd-bind-property="expanded"></section><button data-cd-on="click" data-cd-action="state.set" data-cd-state="open" data-cd-value-field="checked">Toggle</button>`,
      { namespace: "shell" },
    );
    expect(result.interactions.state).toEqual([
      { id: "cd-shell-state-open", type: "boolean", initial: false },
    ]);
    expect(result.interactions.bindings).toEqual([
      { targetId: "cd-shell-drawer", property: "expanded", stateId: "cd-shell-state-open" },
    ]);
    expect(result.interactions.transitions[0]?.action).toEqual({
      type: "state.set",
      stateId: "cd-shell-state-open",
      value: { kind: "event", field: "checked" },
    });
  });

  it("rejects unbounded numeric state", () => {
    expect(() =>
      compileHtml(
        `<div data-cd-state-id="position" data-cd-state-type="boundedNumber" data-cd-state-initial="0"></div>`,
        { namespace: "x" },
      ),
    ).toThrow(/bound/i);
  });

  it.each([
    `<div data-cd-state-id="open" data-cd-state-type="boolean" data-cd-state-initial="false" data-cd-bind-state="open" data-cd-bind-property="progress01"></div>`,
    `<div data-cd-state-id="progress" data-cd-state-type="boundedNumber" data-cd-state-initial="0" data-cd-state-min="0" data-cd-state-max="1" data-cd-bind-state="progress" data-cd-bind-property="expanded"></div>`,
    `<button data-cd-state-id="open" data-cd-state-type="boolean" data-cd-state-initial="false" data-cd-on="click" data-cd-action="state.decrement" data-cd-state="open">Bad</button>`,
  ])("rejects incompatible state bindings and actions: %s", (source) => {
    expect(() => compileHtml(source, { namespace: "x" })).toThrow(/state|binding|action/i);
  });

  it("compiles typed source actions and removes the source syntax", () => {
    const result = compileHtml(
      `<button id="open" data-cd-on="click" data-cd-action="surface.toggle" data-cd-target="drawer">Menu</button><aside id="drawer"></aside>`,
      { namespace: "shell" },
    );
    expect(result.html).not.toContain("data-cd-action");
    expect(result.interactions.transitions).toEqual([
      {
        on: "click",
        sourceId: "cd-shell-open",
        action: { type: "surface.toggle", surfaceId: "cd-shell-drawer" },
      },
    ]);
  });

  it("rejects arbitrary actions, selectors, and generated commerce mutations", () => {
    expect(() =>
      compileHtml(`<button data-cd-on="click" data-cd-action="javascript:alert(1)">x</button>`, {
        namespace: "x",
      }),
    ).toThrow(/action/i);
    expect(() =>
      compileHtml(
        `<button data-cd-on="click" data-cd-action="surface.open" data-cd-target="body > *">x</button>`,
        { namespace: "x" },
      ),
    ).toThrow(/target/i);
    expect(() =>
      compileHtml(`<button data-cd-on="click" data-cd-action="cart.add">x</button>`, { namespace: "x" }),
    ).toThrow(/action/i);
  });

  it("compiles trusted commerce slots independently from actions", () => {
    const result = compileHtml(
      `<div id="buy" data-cd-slot="addToCart" data-cd-product="product.id" data-cd-host-size="block"></div>`,
      { namespace: "product", rootScopeKind: "product" },
    );
    expect(result.trustedSlots).toEqual([
      expect.objectContaining({ id: "cd-product-slot-1", kind: "addToCart", hostSize: "block" }),
    ]);
    expect(result.html).not.toContain("data-cd-slot");
    expect(result.html).not.toContain("id=\"cd-product-buy\"");
  });

  it("allows only bounded personalization fields on the trusted add-to-cart slot", () => {
    const result = compileHtml(
      `<div data-cd-slot="addToCart" data-cd-personalization="engraving giftNote recipient"></div>`,
      { namespace: "product", rootScopeKind: "product" },
    );
    expect(result.trustedSlots[0]).toEqual(expect.objectContaining({
      kind: "addToCart",
      personalizationFields: ["engraving", "giftNote", "recipient"],
    }));
    expect(result.html).not.toContain("personalization");

    expect(() => compileHtml(
      `<div data-cd-slot="addToCart" data-cd-personalization="engraving price"></div>`,
      { namespace: "product", rootScopeKind: "product" },
    )).toThrow(/personalization/i);
    expect(() => compileHtml(
      `<div data-cd-slot="quickViewCommerce" data-cd-personalization="engraving"></div>`,
      { namespace: "home" },
    )).toThrow(/personalization/i);
  });

  it("requires cart-line controls to be inside the exact cart-line repeat scope", () => {
    expect(() => compileHtml(
      `<div data-cd-slot="cartLineControls"></div>`,
      { namespace: "cart", rootScopeKind: "cart" },
    )).toThrow(/cart.?line|repeat|scope/i);

    const result = compileHtml(
      `<main data-cd-repeat="cart.lines"><div data-cd-key="cartLine.id" data-cd-slot="cartLineControls"></div></main>`,
      { namespace: "cart", rootScopeKind: "cart" },
    );
    expect(result.trustedSlots).toEqual([
      expect.objectContaining({ kind: "cartLineControls", scopeId: "cd-cart-scope-1" }),
    ]);
  });
});
