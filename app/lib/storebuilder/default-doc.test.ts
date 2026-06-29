// app/lib/storebuilder/default-doc.test.ts
import { describe, it, expect } from "vitest";
import { defaultHomeDocument } from "./default-doc";
import { validateDocument } from "./validate";

describe("defaultHomeDocument", () => {
  it("is a valid singleton home doc with a hero + an all-products grid", () => {
    const doc = defaultHomeDocument();
    expect(doc.kind).toBe("singleton");
    expect(doc.pageKey).toBe("home");
    expect(doc.blocks.map((b) => b.type)).toEqual(["hero", "productGrid"]);
    const grid = doc.blocks[1].props.source as { kind: string };
    expect(grid.kind).toBe("all"); // never references a specific id → never blanks
  });

  it("survives validateDocument unchanged (no dropped refs)", () => {
    const result = validateDocument(defaultHomeDocument(), { productIds: new Set(), collectionHandles: new Set() });
    expect(result.dropped).toHaveLength(0);
    expect(result.doc.blocks).toHaveLength(2);
  });
});
