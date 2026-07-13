// validateProductInput handle rules: opt-in field, normalized (trim/lowercase),
// slug-shaped, 1-80 chars. A present-but-malformed handle is a deliberate edit
// gone wrong and must 422 (invalid_handle) — never be silently dropped.
import { describe, it, expect } from "vitest";
import { validateProductInput } from "../validate";

const base = { title: "Tee", status: "active", variants: [{ sku: "T", requiresShipping: false }] };

function run(handle: unknown) {
  return validateProductInput({ ...base, handle });
}

describe("validateProductInput handle", () => {
  it("leaves an absent handle undefined (create keeps generating; update keeps stored)", () => {
    const r = validateProductInput(base);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.handle).toBeUndefined();
  });

  it("treats null like absent", () => {
    const r = run(null);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.handle).toBeUndefined();
  });

  it("accepts a well-formed slug", () => {
    const r = run("summer-tee-2");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.handle).toBe("summer-tee-2");
  });

  it("trims and lowercases before validating", () => {
    const r = run("  Summer-Tee  ");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.handle).toBe("summer-tee");
  });

  it("accepts a single-segment handle and one at the 80-char limit", () => {
    expect(run("tee").ok).toBe(true);
    expect(run("a".repeat(80)).ok).toBe(true);
  });

  const bad: Array<[string, unknown]> = [
    ["empty string", ""],
    ["whitespace only", "   "],
    ["spaces inside", "summer tee"],
    ["leading hyphen", "-tee"],
    ["trailing hyphen", "tee-"],
    ["double hyphen", "summer--tee"],
    ["unicode / punctuation", "tée!"],
    ["slash", "summer/tee"],
    ["over 80 chars", "a".repeat(81)],
    ["non-string", 42],
    ["object", { handle: "x" }],
  ];
  for (const [label, value] of bad) {
    it(`rejects ${label} with invalid_handle`, () => {
      const r = run(value);
      expect(r).toEqual({ ok: false, code: "invalid_handle" });
    });
  }
});
