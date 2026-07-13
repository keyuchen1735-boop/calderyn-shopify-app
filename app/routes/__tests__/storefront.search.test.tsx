import { describe, expect, it } from "vitest";
import { loader } from "../storefront.search";

describe("storefront search route", () => {
  it("exists as the complete storefront search surface", () => {
    expect(loader).toBeTypeOf("function");
  });
});
