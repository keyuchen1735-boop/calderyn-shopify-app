// validateProductInput seo rules: opt-in block, trimmed + clamped (70/200 hard
// caps behind the 60/160 soft UI limits), empties preserved (the route's delete
// cue), non-string fields rejected as a crafted body.
import { describe, it, expect } from "vitest";
import { validateProductInput } from "../validate";

const base = { title: "Tee", status: "active", variants: [{ sku: "T", requiresShipping: false }] };

function run(seo: unknown) {
  return validateProductInput({ ...base, seo });
}

describe("validateProductInput seo", () => {
  it("leaves an absent seo block undefined", () => {
    const r = validateProductInput(base);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.seo).toBeUndefined();
  });

  it("trims both fields", () => {
    const r = run({ metaTitle: "  Cozy Tee  ", metaDescription: "  Soft cotton.  " });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.seo).toEqual({ metaTitle: "Cozy Tee", metaDescription: "Soft cotton." });
  });

  it("keeps both-empty (the remove-override signal) instead of dropping the block", () => {
    const r = run({ metaTitle: "", metaDescription: "" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.seo).toEqual({ metaTitle: "", metaDescription: "" });
  });

  it("treats missing fields inside the block as empty", () => {
    const r = run({});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.seo).toEqual({ metaTitle: "", metaDescription: "" });
  });

  it("clamps metaTitle to 70 chars and metaDescription to 200", () => {
    const r = run({ metaTitle: "t".repeat(90), metaDescription: "d".repeat(250) });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.seo?.metaTitle).toBe("t".repeat(70));
      expect(r.value.seo?.metaDescription).toBe("d".repeat(200));
    }
  });

  it("clamps by code point — an emoji straddling the cut survives whole, never a lone surrogate", () => {
    // 69 chars + two emoji = 71 code points; the clamp keeps 70 (the first
    // emoji intact). A UTF-16 .slice(0, 70) would have cut the first emoji's
    // surrogate pair in half.
    const r = run({ metaTitle: "x".repeat(69) + "😀😀", metaDescription: "d".repeat(199) + "🎉🎉" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.seo?.metaTitle).toBe("x".repeat(69) + "😀");
      expect(r.value.seo?.metaDescription).toBe("d".repeat(199) + "🎉");
    }
  });

  it("leaves an emoji-only value within the limit untouched", () => {
    const r = run({ metaTitle: "😀".repeat(70), metaDescription: "" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.seo?.metaTitle).toBe("😀".repeat(70));
  });

  it("rejects a non-object seo block with invalid_seo", () => {
    expect(run("meta")).toEqual({ ok: false, code: "invalid_seo" });
    expect(run(["a"])).toEqual({ ok: false, code: "invalid_seo" });
  });

  it("rejects non-string fields with invalid_seo", () => {
    expect(run({ metaTitle: 42 })).toEqual({ ok: false, code: "invalid_seo" });
    expect(run({ metaDescription: { x: 1 } })).toEqual({ ok: false, code: "invalid_seo" });
  });
});
