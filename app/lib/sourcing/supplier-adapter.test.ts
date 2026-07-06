// app/lib/sourcing/supplier-adapter.test.ts
import { describe, it, expect } from "vitest";
import { getSupplierAdapter } from "./supplier-adapter";

describe("getSupplierAdapter", () => {
  it("returns the fixture adapter by name", () => {
    const adapter = getSupplierAdapter("fixture");
    expect(adapter.provider).toBe("fixture");
    expect(typeof adapter.getTrending).toBe("function");
  });

  it("throws on an unknown provider (fail visibly, rule 12)", () => {
    expect(() => getSupplierAdapter("nope")).toThrow(/unknown sourcing provider/i);
  });
});
