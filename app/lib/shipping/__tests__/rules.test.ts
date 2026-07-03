import { describe, it, expect } from "vitest";
import { applyMerchantRules, selectOptions } from "../rules";
import type { NormalizedRateOption } from "../../ship-cost/adapters/rate-quote";
import type { ShippingQuoteOption } from "../quote";

const carrier: NormalizedRateOption = {
  carrier: "USPS",
  serviceCode: "Priority",
  serviceName: "Priority",
  amountCents: 739,
  currency: "USD",
  estTransitDays: 2,
  guaranteed: false,
  deliveryDateEstimate: null,
  rateType: "list",
};

describe("applyMerchantRules", () => {
  it("applies NO rules → amount equals base, empty appliedRules, base preserved", () => {
    const o = applyMerchantRules(carrier, undefined, 5000, null);
    expect(o.amountCents).toBe(739);
    expect(o.baseAmountCents).toBe(739);
    expect(o.appliedRules).toEqual([]);
  });

  it("applies markup as a percentage and records it (rounded integer cents)", () => {
    const o = applyMerchantRules(carrier, { markupPct: 10 }, 5000, null);
    expect(o.amountCents).toBe(813); // round(739 * 1.1) = round(812.9)
    expect(o.baseAmountCents).toBe(739);
    expect(o.appliedRules).toEqual(["markup:10%"]);
  });

  it("applies flat handling and records it", () => {
    const o = applyMerchantRules(carrier, { handlingCents: 500 }, 5000, null);
    expect(o.amountCents).toBe(1239);
    expect(o.appliedRules).toEqual(["handling:500"]);
  });

  it("applies markup THEN handling, recording each rule explicitly in order (rule 7)", () => {
    const o = applyMerchantRules(carrier, { markupPct: 10, handlingCents: 500 }, 5000, null);
    expect(o.amountCents).toBe(1313); // 813 + 500
    expect(o.appliedRules).toEqual(["markup:10%", "handling:500"]);
  });

  it("ignores a 0% markup / 0 handling (no-op, not recorded)", () => {
    const o = applyMerchantRules(carrier, { markupPct: 0, handlingCents: 0 }, 5000, null);
    expect(o.amountCents).toBe(739);
    expect(o.appliedRules).toEqual([]);
  });

  describe("free-ship threshold boundary", () => {
    it("does NOT free-ship just below the threshold", () => {
      const o = applyMerchantRules(carrier, { freeShipThresholdCents: 5000 }, 4999, null);
      expect(o.amountCents).toBe(739);
      expect(o.appliedRules).toEqual([]);
    });

    it("free-ships AT the threshold (>=), zeroing amount but preserving base", () => {
      const o = applyMerchantRules(carrier, { freeShipThresholdCents: 5000 }, 5000, null);
      expect(o.amountCents).toBe(0);
      expect(o.baseAmountCents).toBe(739);
      expect(o.appliedRules).toEqual(["freeship"]);
    });
  });

  it("free-ship overrides markup+handling (applied last) yet records all three rules (rule 7)", () => {
    const o = applyMerchantRules(
      carrier,
      { markupPct: 10, handlingCents: 500, freeShipThresholdCents: 5000 },
      5000,
      null,
    );
    expect(o.amountCents).toBe(0);
    expect(o.baseAmountCents).toBe(739);
    expect(o.appliedRules).toEqual(["markup:10%", "handling:500", "freeship"]);
  });

  it("carries carrier + delivery-window provenance onto the quote option", () => {
    const o = applyMerchantRules(carrier, undefined, 0, {
      earliest: "2026-07-01",
      latest: "2026-07-02",
    });
    expect(o).toMatchObject({
      service: "Priority",
      serviceName: "Priority",
      carrier: "USPS",
      currency: "USD",
      guaranteed: false,
      pickupAvailable: false,
      deliveryWindow: { earliest: "2026-07-01", latest: "2026-07-02" },
    });
  });
});

function opt(service: string, amountCents: number, earliest: string, latest: string): ShippingQuoteOption {
  return {
    service,
    serviceName: service,
    carrier: "USPS",
    amountCents,
    baseAmountCents: amountCents,
    appliedRules: [],
    currency: "USD",
    deliveryWindow: { earliest, latest },
    guaranteed: false,
    pickupAvailable: false,
  };
}

describe("selectOptions", () => {
  const cheap = opt("Ground", 500, "2026-07-10", "2026-07-12");
  const fast = opt("Express", 2000, "2026-07-01", "2026-07-01");
  const mid = opt("Priority", 900, "2026-07-05", "2026-07-06");
  const all = [cheap, fast, mid];

  it("'all' returns every option unchanged", () => {
    expect(selectOptions(all, "all")).toEqual(all);
  });

  it("'cheapest' returns the single lowest-amount option", () => {
    expect(selectOptions(all, "cheapest").map((o) => o.service)).toEqual(["Ground"]);
  });

  it("'fastest' returns the single earliest-arriving option", () => {
    expect(selectOptions(all, "fastest").map((o) => o.service)).toEqual(["Express"]);
  });

  it("'fastest' breaks an equal-arrival, equal-price tie deterministically by service code", () => {
    // Same earliest date AND same amount → must not depend on carrier list order.
    const b = opt("Bravo", 1200, "2026-07-03", "2026-07-04");
    const a = opt("Alpha", 1200, "2026-07-03", "2026-07-04");
    expect(selectOptions([b, a], "fastest").map((o) => o.service)).toEqual(["Alpha"]);
    expect(selectOptions([a, b], "fastest").map((o) => o.service)).toEqual(["Alpha"]);
  });

  it("'blended' flattens to exactly ONE option, labeled 'blended' explicitly (rule 7, never averaged)", () => {
    const blended = selectOptions(all, "blended");
    expect(blended).toHaveLength(1);
    expect(blended[0].service).toBe("Ground"); // cheapest-serviceable as the flat representative
    expect(blended[0].appliedRules).toContain("blended");
  });

  it("'blended' preserves prior appliedRules and appends 'blended' (does not mutate the source)", () => {
    const withMarkup: ShippingQuoteOption = { ...opt("Ground", 500, "2026-07-10", "2026-07-12"), appliedRules: ["markup:10%"] };
    const source = [withMarkup, fast];
    const blended = selectOptions(source, "blended");
    expect(blended[0].appliedRules).toEqual(["markup:10%", "blended"]);
    expect(withMarkup.appliedRules).toEqual(["markup:10%"]); // source untouched
  });
});
