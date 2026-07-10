import { describe, it, expect } from "vitest";
import { normalizeOrderTags, MAX_ORDER_TAGS } from "./tags";

describe("normalizeOrderTags", () => {
  it("trims, lowercases, and dedupes in first-seen order", () => {
    expect(normalizeOrderTags([" VIP ", "vip", "Wholesale"])).toEqual(["vip", "wholesale"]);
  });

  it("rejects a non-array", () => {
    expect(normalizeOrderTags("vip")).toBeNull();
    expect(normalizeOrderTags(undefined)).toBeNull();
    expect(normalizeOrderTags(null)).toBeNull();
  });

  it("rejects a non-string entry", () => {
    expect(normalizeOrderTags(["vip", 42])).toBeNull();
  });

  it("rejects an empty-after-trim entry and an over-length entry", () => {
    expect(normalizeOrderTags(["   "])).toBeNull();
    expect(normalizeOrderTags(["a".repeat(61)])).toBeNull();
  });

  it("accepts exactly MAX_ORDER_TAGS and an empty array (clears all tags)", () => {
    const max = Array.from({ length: MAX_ORDER_TAGS }, (_, i) => `tag${i}`);
    expect(normalizeOrderTags(max)).toHaveLength(MAX_ORDER_TAGS);
    expect(normalizeOrderTags([])).toEqual([]);
  });

  it("rejects more than MAX_ORDER_TAGS after dedupe", () => {
    const many = Array.from({ length: MAX_ORDER_TAGS + 1 }, (_, i) => `tag${i}`);
    expect(normalizeOrderTags(many)).toBeNull();
  });
});
