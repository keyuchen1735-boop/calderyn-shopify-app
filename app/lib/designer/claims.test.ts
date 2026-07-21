// The D5 deterministic backstop, exercised on the walkthrough's actual
// failure shapes: invented percent-off offers, a WELCOME10-style promo code,
// and free-shipping thresholds ($65/$75) no merchant fact ever supplied.
import { describe, expect, it } from "vitest";
import { claimsRepairInstruction, findUnhonorableClaims } from "./claims";

describe("findUnhonorableClaims", () => {
  it("returns nothing for clean, number-free copy", () => {
    const html = "<p>Fast shipping. Easy returns. Loved by our customers.</p>";
    expect(findUnhonorableClaims(html)).toEqual([]);
  });

  it("flags an invented percent-off offer", () => {
    const out = findUnhonorableClaims("<h3>10% off your first order</h3>");
    expect(out).toEqual([{ kind: "percent-off", excerpt: "10% off" }]);
  });

  it("flags the spelled-out percent form too", () => {
    const out = findUnhonorableClaims("<p>Take 15 percent off today</p>");
    expect(out).toEqual([{ kind: "percent-off", excerpt: "15 percent off" }]);
  });

  it("passes a percent the merchant themselves asked for", () => {
    const out = findUnhonorableClaims("<h3>10% off your first order</h3>", {
      providedFacts: "Give new customers 10% off their first order",
    });
    expect(out).toEqual([]);
  });

  it("flags an invented promo code", () => {
    const out = findUnhonorableClaims("<p>Use code WELCOME10 at checkout</p>");
    expect(out.map((c) => c.kind)).toContain("promo-code");
    expect(out.find((c) => c.kind === "promo-code")?.excerpt).toContain("WELCOME10");
  });

  it("passes a promo code the merchant supplied, any case", () => {
    const out = findUnhonorableClaims("<p>Use code SPRING24 at checkout</p>", {
      providedFacts: "our discount code is spring24",
    });
    expect(out.filter((c) => c.kind === "promo-code")).toEqual([]);
  });

  it("does not treat prose uses of the word code as an offer", () => {
    expect(findUnhonorableClaims("<p>Our dress code is casual.</p>")).toEqual([]);
  });

  it("flags an invented free-shipping threshold in copy", () => {
    const out = findUnhonorableClaims("<div>Free shipping on orders over $65</div>");
    expect(out).toEqual([{ kind: "free-shipping-threshold", excerpt: "Free shipping on orders over $65" }]);
  });

  it("flags the declared cart-meter threshold attribute the same way", () => {
    const out = findUnhonorableClaims('<div data-designer-free-shipping="120">Ships free</div>');
    expect(out).toEqual([{ kind: "free-shipping-threshold", excerpt: 'data-designer-free-shipping="120"' }]);
  });

  it("passes a threshold the merchant stated", () => {
    const out = findUnhonorableClaims(
      '<div data-designer-free-shipping="75">Free shipping over $75</div>',
      { providedFacts: "we offer free shipping over $75" },
    );
    expect(out).toEqual([]);
  });

  it("reports the walkthrough page's several invented offers at once, deduped", () => {
    const html = [
      "<div>Free shipping on orders over $65</div>",
      "<p>10% off with code WELCOME10</p>",
      "<footer>Free shipping on orders over $65</footer>",
    ].join("\n");
    const out = findUnhonorableClaims(html);
    expect(out.map((c) => c.kind).sort()).toEqual(["free-shipping-threshold", "percent-off", "promo-code"]);
  });
});

describe("claimsRepairInstruction", () => {
  it("is empty for a clean page", () => {
    expect(claimsRepairInstruction([])).toBe("");
  });

  it("quotes each finding and demands number-free copy", () => {
    const out = claimsRepairInstruction(findUnhonorableClaims("<p>Use code WELCOME10 for 10% off</p>"));
    expect(out).toContain('"code WELCOME10"');
    expect(out).toContain('"10% off"');
    expect(out).toContain("cannot keep");
  });
});
