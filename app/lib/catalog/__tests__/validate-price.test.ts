import { describe, it, expect } from "vitest";
import { validateProductInput } from "../validate";

// requiresShipping:false keeps the shipping-dimension gate out of the way so
// these cases isolate the price/overflow rules.
const base = { title: "Mug", status: "active" as const };
const digital = (extra: Record<string, unknown>) => ({
  ...base,
  variants: [{ sku: "M", requiresShipping: false, ...extra }],
});

describe("active variant pricing", () => {
  it("rejects an ACTIVE variant explicitly priced at 0 (would sell free)", () => {
    const r = validateProductInput(digital({ retailPriceCents: 0 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("zero_price");
  });
  it("allows an ACTIVE variant priced above 0", () => {
    const r = validateProductInput(digital({ retailPriceCents: 2000 }));
    expect(r.ok).toBe(true);
  });
  it("allows an ACTIVE variant with no price (null is filtered by the storefront)", () => {
    const r = validateProductInput(digital({}));
    expect(r.ok).toBe(true);
  });
  it("allows a DRAFT variant priced at 0 (work in progress)", () => {
    const r = validateProductInput({ ...base, status: "draft", variants: [{ sku: "M", requiresShipping: false, retailPriceCents: 0 }] });
    expect(r.ok).toBe(true);
  });
});

describe("int4 overflow guard", () => {
  it("rejects a retail price beyond int4 max", () => {
    const r = validateProductInput(digital({ retailPriceCents: 2500000000 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("value_too_large");
  });
  it("rejects a unit cost beyond int4 max", () => {
    const r = validateProductInput(digital({ retailPriceCents: 2000, unitCostCents: 3000000000 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("value_too_large");
  });
  it("rejects stock beyond int4 max", () => {
    const r = validateProductInput(digital({ retailPriceCents: 2000, inventoryOnHand: 3000000000 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("value_too_large");
  });
  it("allows values at the int4 ceiling", () => {
    const r = validateProductInput(digital({ retailPriceCents: 2147483647, inventoryOnHand: 2147483647 }));
    expect(r.ok).toBe(true);
  });
});
