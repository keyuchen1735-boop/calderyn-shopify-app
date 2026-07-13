import { describe, expect, it } from "vitest";
import type { VariantBalanceVM, VariantDraft } from "~/lib/dashboard/client";
import {
  organizeSummary,
  searchSummary,
  shippingSummary,
  stockSummary,
  variantsSummary,
} from "../product-editor-summaries";

function balance(locationId: string, onHand: number): VariantBalanceVM {
  return {
    locationId,
    locationName: locationId,
    onHand,
    reserved: 0,
    incoming: 0,
    available: onHand,
    reorderPoint: null,
  };
}

describe("variantsSummary", () => {
  it("describes a single priced variant", () => {
    const variants: VariantDraft[] = [{ retailPriceCents: 2400 }];

    expect(variantsSummary([], variants)).toEqual({
      text: "Single variant — $24",
      warning: false,
    });
  });

  it("uses a named option when all variants share one price", () => {
    const variants: VariantDraft[] = [
      { retailPriceCents: 12900 },
      { retailPriceCents: 12900 },
      { retailPriceCents: 12900 },
    ];

    expect(
      variantsSummary([{ name: "Size", values: ["S", "M", "L"] }], variants),
    ).toEqual({ text: "3 sizes — all $129", warning: false });
  });

  it("calls out mixed and missing prices across multiple variants", () => {
    expect(
      variantsSummary([], [
        { retailPriceCents: 2400 },
        { retailPriceCents: 2900 },
      ]),
    ).toEqual({ text: "2 variants — mixed prices", warning: false });

    expect(variantsSummary([], [{}, {}])).toEqual({
      text: "2 variants — no prices",
      warning: false,
    });
  });
});

describe("stockSummary", () => {
  it("aggregates reported on-hand stock across unique locations", () => {
    const variants: VariantDraft[] = [
      { id: "v1", inventoryOnHand: 1 },
      { id: "v2", inventoryOnHand: 2 },
    ];

    expect(
      stockSummary(variants, {
        v1: [balance("loc-1", 50)],
        v2: [balance("loc-1", 25)],
      }),
    ).toEqual({ text: "75 on hand · 1 location", warning: false });
  });

  it("uses flat stock until every tracked variant reports and warns at zero", () => {
    const variants: VariantDraft[] = [
      { id: "v1", inventoryOnHand: 50 },
      { id: "v2", inventoryOnHand: 25 },
    ];

    expect(stockSummary(variants, { v1: [balance("loc-1", 50)] })).toEqual({
      text: "75 on hand",
      warning: false,
    });
    expect(stockSummary([{ id: "v1", inventoryOnHand: 0 }], {})).toEqual({
      text: "Out of stock ⚠",
      warning: true,
    });
    expect(stockSummary([{ inventoryTracked: false }], {})).toEqual({
      text: "Not tracked",
      warning: false,
    });
  });
});

describe("shippingSummary", () => {
  it("formats one complete physical shipping shape", () => {
    expect(
      shippingSummary([
        {
          weightGrams: 600,
          lengthMm: 400,
          widthMm: 350,
          heightMm: 80,
        },
      ]),
    ).toEqual({ text: "600 g · 40×35×8 cm", warning: false });
  });

  it("warns with the precise missing physical shipping data", () => {
    const complete = { weightGrams: 600, lengthMm: 400, widthMm: 350, heightMm: 80 };

    expect(shippingSummary([{ ...complete, weightGrams: 0 }])).toEqual({
      text: "Missing weight ⚠",
      warning: true,
    });
    expect(shippingSummary([{ ...complete, lengthMm: undefined }])).toEqual({
      text: "Missing dimensions ⚠",
      warning: true,
    });
    expect(
      shippingSummary([{ weightGrams: 0, requiresShipping: true }]),
    ).toEqual({ text: "Missing weight + dimensions ⚠", warning: true });
    expect(shippingSummary([{ requiresShipping: false }])).toEqual({
      text: "No shipping needed",
      warning: false,
    });
  });

  it("summarizes complete mixed physical shapes without warning", () => {
    const first = { weightGrams: 600, lengthMm: 400, widthMm: 350, heightMm: 80 };
    const second = { weightGrams: 700, lengthMm: 420, widthMm: 350, heightMm: 80 };

    expect(shippingSummary([first, second, { requiresShipping: false }])).toEqual({
      text: "2 variants · shipping complete",
      warning: false,
    });
    expect(shippingSummary([first, { ...first }])).toEqual({
      text: "600 g · 40×35×8 cm",
      warning: false,
    });
  });
});

describe("searchSummary", () => {
  const automatic = {
    handle: "trail-shirt",
    savedHandle: "trail-shirt",
    metaTitle: "",
    metaDescription: "",
    seoAvailable: true,
  };

  it("describes automatic, customized, and unavailable search listings", () => {
    expect(searchSummary(automatic)).toEqual({ text: "Automatic", warning: false });
    expect(searchSummary({ ...automatic, metaTitle: "Trail Shirt" })).toEqual({
      text: "Custom title",
      warning: false,
    });
    expect(
      searchSummary({
        ...automatic,
        handle: "new-address",
        metaTitle: "Trail Shirt",
        metaDescription: "Built for the trail.",
      }),
    ).toEqual({ text: "Custom address + title + description", warning: false });
    expect(searchSummary({ ...automatic, seoAvailable: false })).toEqual({
      text: "Temporarily unavailable",
      warning: false,
    });
  });
});

describe("organizeSummary", () => {
  it("summarizes vendor, nonblank tags, and collection membership", () => {
    expect(organizeSummary("", "", [])).toEqual({ text: "Nothing yet", warning: false });
    expect(organizeSummary("", "summer, , sale", [])).toEqual({
      text: "2 tags · no collections",
      warning: false,
    });
    expect(organizeSummary(" Peak & Pine ", "summer", ["c1", "c2"])).toEqual({
      text: "Peak & Pine · 1 tag · 2 collections",
      warning: false,
    });
  });
});
