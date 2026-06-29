import { describe, it, expect } from "vitest";
import { buildDeliveryWindow } from "../delivery-window";
import type { NormalizedRateOption } from "../../ship-cost/adapters/rate-quote";

const base: NormalizedRateOption = {
  carrier: "USPS",
  serviceCode: "Priority",
  serviceName: "Priority",
  amountCents: 739,
  currency: "USD",
  estTransitDays: null,
  guaranteed: false,
  deliveryDateEstimate: null,
  rateType: "list",
};

describe("buildDeliveryWindow", () => {
  const now = new Date("2026-06-29T12:00:00Z"); // Monday

  it("combines carrier transit with a handling band: earliest=now+transit, latest=now+handling+transit", () => {
    const w = buildDeliveryWindow({ ...base, estTransitDays: 3 }, 1, now);
    expect(w).toEqual({ earliest: "2026-07-02", latest: "2026-07-03" });
  });

  it("with zero handling the window collapses to a single day", () => {
    const w = buildDeliveryWindow({ ...base, estTransitDays: 2 }, 0, now);
    expect(w).toEqual({ earliest: "2026-07-01", latest: "2026-07-01" });
  });

  it("prefers an absolute carrier delivery date; handling only widens the late bound", () => {
    const w = buildDeliveryWindow(
      { ...base, estTransitDays: 99, deliveryDateEstimate: "2026-07-02T00:00:00Z" },
      2,
      now,
    );
    expect(w).toEqual({ earliest: "2026-07-02", latest: "2026-07-04" });
  });

  it("returns null when neither transit days nor a delivery date is known", () => {
    expect(buildDeliveryWindow(base, 1, now)).toBeNull();
  });
});
