import { describe, it, expect } from "vitest";
import { isValidViewFilters, VIEW_FILTER_KEYS } from "./view-filters";

describe("isValidViewFilters", () => {
  it("accepts an empty object and a full set of known keys with primitive/string[] values", () => {
    expect(isValidViewFilters({})).toEqual({});
    const full = {
      search: "vip",
      payment_status: ["paid", "partially_refunded"],
      fulfillment_status: "unfulfilled",
      source: "calderyn",
      date_from: "2026-01-01T00:00:00Z",
      date_to: "2026-01-31T23:59:59Z",
      tag: "rush",
      archived: true,
      sort: "date",
      dir: "desc",
    };
    expect(isValidViewFilters(full)).toEqual(full);
    expect(VIEW_FILTER_KEYS).toContain("payment_status");
  });

  it("rejects a non-object (string, number, array, null)", () => {
    expect(isValidViewFilters("search=vip")).toBeNull();
    expect(isValidViewFilters(42)).toBeNull();
    expect(isValidViewFilters(["search"])).toBeNull();
    expect(isValidViewFilters(null)).toBeNull();
  });

  it("rejects an unknown key", () => {
    expect(isValidViewFilters({ search: "vip", bogus: "x" })).toBeNull();
  });

  it("rejects a nested object value", () => {
    expect(isValidViewFilters({ search: { nested: true } })).toBeNull();
  });

  it("rejects an array containing a non-string entry", () => {
    expect(isValidViewFilters({ payment_status: ["paid", 42] })).toBeNull();
  });

  it("rejects a number value (only string/boolean/string[] accepted)", () => {
    expect(isValidViewFilters({ offset: 5 })).toBeNull();
    expect(isValidViewFilters({ search: 5 })).toBeNull();
  });
});
