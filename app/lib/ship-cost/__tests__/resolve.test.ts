import { describe, it, expect } from "vitest";
import { resolveOrderShipCost } from "../resolve";

const base = { fallbackCents: 500 } as const;

describe("resolveOrderShipCost", () => {
  it("manual override wins over everything", () => {
    const r = resolveOrderShipCost({ ...base, manualOverrideCents: 700, invoiceLineCents: 100, allocatedCents: 200 });
    expect(r).toEqual({ cents: 700, source: "manual", confidence: "high" });
  });
  it("invoice beats event and allocation", () => {
    const r = resolveOrderShipCost({ ...base, invoiceLineCents: 450, eventParsedCents: 480, allocatedCents: 600 });
    expect(r.source).toBe("actual_invoice");
    expect(r.confidence).toBe("high");
  });
  it("event (reconciled) beats allocation", () => {
    const r = resolveOrderShipCost({ ...base, eventParsedCents: 480, allocatedCents: 600 });
    expect(r).toEqual({ cents: 480, source: "actual_event", confidence: "med" });
  });
  it("allocation confidence tracks coverage", () => {
    expect(resolveOrderShipCost({ ...base, allocatedCents: 600, allocationCoverage: "full" }).confidence).toBe("high");
    expect(resolveOrderShipCost({ ...base, allocatedCents: 600, allocationCoverage: "partial" }).confidence).toBe("med");
  });
  it("modeled then fallback when no total", () => {
    expect(resolveOrderShipCost({ ...base, modeledCents: 550 }).source).toBe("modeled");
    expect(resolveOrderShipCost({ ...base }).source).toBe("fallback");
    expect(resolveOrderShipCost({ ...base }).confidence).toBe("low");
  });
});
