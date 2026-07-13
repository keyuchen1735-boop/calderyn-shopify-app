import { describe, it, expect } from "vitest";
import { validateProductInput } from "../validate";
import type { ProductDetail } from "../types";

const base = { title: "Mug", status: "active" as const };

function legacyProduct(
  status: ProductDetail["status"] = "active",
): ProductDetail {
  return {
    id: "p1",
    handle: "mug",
    title: "Mug",
    status,
    vendor: null,
    category: null,
    description: null,
    tags: [],
    options: [],
    variants: [
      {
        id: "v1",
        sku: "M",
        title: "Default",
        retailPriceCents: 2000,
        compareAtPriceCents: null,
        unitCostCents: null,
        inventoryTracked: true,
        inventoryOnHand: 1,
        optionValueIds: [],
        weightGrams: 340,
        lengthMm: null,
        widthMm: null,
        heightMm: null,
        requiresShipping: true,
        handlingDays: 0,
        signatureRequired: false,
        restrictedCountries: [],
      },
    ],
    media: [],
    collectionIds: [],
    updatedAt: "2026-07-10T00:00:00.000Z",
  };
}

const legacyVariant = {
  id: "v1",
  sku: "M",
  retailPriceCents: 2000,
  requiresShipping: true,
  weightGrams: 340,
};

describe("shipping validation", () => {
  it("rejects an ACTIVE physical variant missing dimensions", () => {
    const r = validateProductInput({
      ...base,
      variants: [{ sku: "M", requiresShipping: true, weightGrams: 340 }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("incomplete_shipping");
  });
  it("allows an ACTIVE physical variant with weight + dims", () => {
    const r = validateProductInput({
      ...base,
      variants: [
        {
          sku: "M",
          requiresShipping: true,
          weightGrams: 340,
          lengthMm: 127,
          widthMm: 127,
          heightMm: 102,
        },
      ],
    });
    expect(r.ok).toBe(true);
  });
  it("allows a digital (requires_shipping=false) variant with no dims", () => {
    const r = validateProductInput({
      ...base,
      variants: [{ sku: "D", requiresShipping: false }],
    });
    expect(r.ok).toBe(true);
  });
  it("allows a DRAFT physical variant with no dims (only active is gated)", () => {
    const r = validateProductInput({
      ...base,
      status: "draft",
      variants: [{ sku: "M", requiresShipping: true }],
    });
    expect(r.ok).toBe(true);
  });
  it("rejects a restricted country that is not ISO-3166 alpha-2", () => {
    const r = validateProductInput({
      ...base,
      variants: [
        {
          sku: "M",
          requiresShipping: true,
          weightGrams: 340,
          lengthMm: 127,
          widthMm: 127,
          heightMm: 102,
          restrictedCountries: ["US", "GBR"],
        },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_country");
  });
  it("allows valid ISO-3166 alpha-2 restricted countries", () => {
    const r = validateProductInput({
      ...base,
      variants: [
        {
          sku: "M",
          requiresShipping: true,
          weightGrams: 340,
          lengthMm: 127,
          widthMm: 127,
          heightMm: 102,
          restrictedCountries: ["US", "GB"],
        },
      ],
    });
    expect(r.ok).toBe(true);
  });

  it("allows an SEO-only round-trip of unchanged incomplete shipping on an already-active product", () => {
    const r = validateProductInput(
      {
        ...base,
        seo: { metaTitle: "Ceramic mug", metaDescription: "" },
        variants: [legacyVariant],
      },
      { previous: legacyProduct() },
    );
    expect(r.ok).toBe(true);
  });

  it("still rejects incomplete shipping when any shipping field is edited", () => {
    const r = validateProductInput(
      { ...base, variants: [{ ...legacyVariant, handlingDays: 2 }] },
      { previous: legacyProduct() },
    );
    expect(r).toEqual({ ok: false, code: "incomplete_shipping" });
  });

  it("still rejects incomplete shipping when a draft is activated", () => {
    const r = validateProductInput(
      { ...base, variants: [legacyVariant] },
      { previous: legacyProduct("draft") },
    );
    expect(r).toEqual({ ok: false, code: "incomplete_shipping" });
  });

  it("still rejects incomplete shipping when the variant set changes", () => {
    const r = validateProductInput(
      { ...base, variants: [{ ...legacyVariant, id: undefined }] },
      { previous: legacyProduct() },
    );
    expect(r).toEqual({ ok: false, code: "incomplete_shipping" });
  });
});
