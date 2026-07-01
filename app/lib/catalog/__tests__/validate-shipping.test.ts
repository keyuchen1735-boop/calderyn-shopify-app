import { describe, it, expect } from "vitest";
import { validateProductInput } from "../validate";

const base = { title: "Mug", status: "active" as const };

describe("shipping validation", () => {
  it("rejects an ACTIVE physical variant missing dimensions", () => {
    const r = validateProductInput({ ...base, variants: [{ sku: "M", requiresShipping: true, weightGrams: 340 }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("incomplete_shipping");
  });
  it("allows an ACTIVE physical variant with weight + dims", () => {
    const r = validateProductInput({ ...base, variants: [{ sku: "M", requiresShipping: true, weightGrams: 340, lengthMm: 127, widthMm: 127, heightMm: 102 }] });
    expect(r.ok).toBe(true);
  });
  it("allows a digital (requires_shipping=false) variant with no dims", () => {
    const r = validateProductInput({ ...base, variants: [{ sku: "D", requiresShipping: false }] });
    expect(r.ok).toBe(true);
  });
  it("allows a DRAFT physical variant with no dims (only active is gated)", () => {
    const r = validateProductInput({ ...base, status: "draft", variants: [{ sku: "M", requiresShipping: true }] });
    expect(r.ok).toBe(true);
  });
  it("rejects a restricted country that is not ISO-3166 alpha-2", () => {
    const r = validateProductInput({ ...base, variants: [{ sku: "M", requiresShipping: true, weightGrams: 340, lengthMm: 127, widthMm: 127, heightMm: 102, restrictedCountries: ["US", "GBR"] }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_country");
  });
  it("allows valid ISO-3166 alpha-2 restricted countries", () => {
    const r = validateProductInput({ ...base, variants: [{ sku: "M", requiresShipping: true, weightGrams: 340, lengthMm: 127, widthMm: 127, heightMm: 102, restrictedCountries: ["US", "GB"] }] });
    expect(r.ok).toBe(true);
  });
});
