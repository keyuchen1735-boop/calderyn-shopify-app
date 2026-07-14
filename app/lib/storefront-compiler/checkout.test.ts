import { describe, expect, it } from "vitest";
import { compileCheckout } from "./checkout";
import type { CheckoutLayoutManifest } from "../storefront-bundle/types";

const layout: CheckoutLayoutManifest = {
  columnMode: "summaryAside" as const,
  sectionOrder: ["contact", "shipping", "delivery", "consent", "payment", "summary"],
  spacingTokenId: "space-4",
  surfaceTokenIds: ["surface", "border"],
};

describe("compileCheckout", () => {
  it("allows decorative identity and policy content", () => {
    const result = compileCheckout({
      html: `<header data-cd-text="store.name"></header><nav data-cd-policy-links></nav>`,
      css: `.trust { color: var(--ink) }`,
      layout,
    });
    expect(result.requiredData).toEqual([{ kind: "storeIdentity" }, { kind: "policyLinks" }]);
  });

  it.each([
    `<form></form>`,
    `<button>Pay</button>`,
    `<div data-cd-text="cart.total"></div>`,
    `<div data-cd-slot="cartSummary"></div>`,
    `<div style="position:fixed"></div>`,
  ])("rejects checkout impersonation: %s", (html) => {
    expect(() => compileCheckout({ html, css: "", layout })).toThrow();
  });

  it.each([
    `.brand { position: fixed }`,
    `.brand { transform: translateY(-100px) }`,
    `.brand { pointer-events: none }`,
    `.brand::before { content: "Pay now" }`,
  ])("rejects checkout CSS that could cover or impersonate protected controls: %s", (css) => {
    expect(() => compileCheckout({ html: `<header class="brand">Brand</header>`, css, layout })).toThrow();
  });

  it.each([
    `.brand { opacity: calc(1 - .5) }`,
    `.brand { margin-top: -40px }`,
    `.brand { width: 99999px }`,
    `.brand { min-height: 200vh }`,
    `.brand { background: linear-gradient(red, transparent) }`,
    `.brand { grid-area: "summary / payment" }`,
  ])("rejects unbounded checkout decoration: %s", (css) => {
    expect(() => compileCheckout({ html: `<header class="brand">Brand</header>`, css, layout })).toThrow();
  });
});
