import { describe, it, expect } from "vitest";
import { gidToId, moneyToCents } from "../mappers.server";

describe("gidToId", () => {
  it("extracts the trailing id from a Shopify GID", () => {
    expect(gidToId("gid://shopify/ProductVariant/12345")).toBe("12345");
  });
  it("returns the input unchanged when no slash segment", () => {
    expect(gidToId("12345")).toBe("12345");
  });
});

describe("moneyToCents", () => {
  it("converts decimal strings to integer cents", () => {
    expect(moneyToCents("19.99")).toBe(1999);
  });
  it("treats null/undefined as 0", () => {
    expect(moneyToCents(null)).toBe(0);
    expect(moneyToCents(undefined)).toBe(0);
  });
});
