import { describe, it, expect } from "vitest";
import { collectionHandle } from "../handle";

describe("collectionHandle", () => {
  it("slugifies a title and trims edge dashes", () => {
    expect(collectionHandle("Summer Drop!")).toBe("summer-drop");
  });

  it("truncates to 60 chars", () => {
    expect(collectionHandle("a".repeat(80))).toHaveLength(60);
  });

  it("falls back to 'collection' when the title has no alphanumerics", () => {
    expect(collectionHandle("!!!")).toBe("collection");
  });
});
