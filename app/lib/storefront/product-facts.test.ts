import { describe, expect, it } from "vitest";
import {
  deriveFactFacets,
  filterProductsByFacts,
  normalizeProductFacts,
  productCompatibility,
  roomFit,
} from "./product-facts";

describe("trusted product facts", () => {
  it("validates the closed field and unit catalog", () => {
    expect(normalizeProductFacts([
      { kind: "dimension.width", value: 80, unit: "cm" },
      { kind: "material", value: "  Solid walnut  " },
      { kind: "heat_level", value: 4 },
    ])).toMatchObject([
      { kind: "dimension.width", numberValue: 80, unit: "cm" },
      { kind: "material", textValue: "Solid walnut", unit: null },
      { kind: "heat_level", numberValue: 4, unit: null },
    ]);
    expect(() => normalizeProductFacts([{ kind: "dimension.width", value: 2, unit: "kg" }])).toThrow(/unit/i);
    expect(() => normalizeProductFacts([{ kind: "material", value: 7 }])).toThrow(/text/i);
    expect(() => normalizeProductFacts([{ kind: "medical_claim", value: "cures" }])).toThrow(/kind/i);
    expect(() => normalizeProductFacts([
      { kind: "dimension.width", value: 80, unit: "cm" },
      { kind: "dimension.width", value: 32, unit: "in" },
    ])).toThrow(/duplicate/i);
  });

  it("rejects unsafe document and model URLs", () => {
    expect(() => normalizeProductFacts([{ kind: "document_url", value: "http://cdn.example/spec.pdf" }])).toThrow(/url/i);
    expect(() => normalizeProductFacts([{ kind: "ar_model_url", value: "https://cdn.example/model.exe" }])).toThrow(/model/i);
    expect(normalizeProductFacts([
      { kind: "document_url", value: "https://cdn.example/spec.pdf" },
      { kind: "ar_model_url", value: "https://cdn.example/chair.glb" },
    ])).toHaveLength(2);
  });

  it("normalizes units for room containment and hides missing results", () => {
    const facts = normalizeProductFacts([
      { kind: "dimension.width", value: 40, unit: "in" },
      { kind: "dimension.depth", value: 100, unit: "cm" },
      { kind: "dimension.height", value: 900, unit: "mm" },
    ]);
    expect(roomFit(facts, { width: 1100, depth: 41, height: 1, unit: "m" })).toBe(true);
    expect(roomFit(facts.slice(0, 2), { width: 2, depth: 2, height: 2, unit: "m" })).toBeNull();
  });

  it("matches compatibility deterministically and derives filters only from facts", () => {
    const one = normalizeProductFacts([{ kind: "compatibility", value: "Model X" }, { kind: "material", value: "Walnut" }]);
    const two = normalizeProductFacts([{ kind: "compatibility", value: "Model Y" }]);
    expect(productCompatibility(one, " model x ")).toBe(true);
    expect(productCompatibility([], "Model X")).toBeNull();
    expect(deriveFactFacets([{ id: "one", facts: one }, { id: "two", facts: two }])).toEqual({
      compatibility: ["Model X", "Model Y"], material: ["Walnut"],
    });
    expect(filterProductsByFacts([{ id: "one", facts: one }, { id: "two", facts: two }], { compatibility: "Model X" }).map(({ id }) => id)).toEqual(["one"]);
  });
});
