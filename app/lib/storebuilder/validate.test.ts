// app/lib/storebuilder/validate.test.ts
import { describe, it, expect } from "vitest";
import { validateDocument, type ValidIds } from "./validate";
import type { BlockDocument } from "./types";

const valid: ValidIds = { productIds: new Set(["1", "2"]), collectionHandles: new Set(["summer"]) };
const doc = (blocks: BlockDocument["blocks"]): BlockDocument => ({ kind: "singleton", pageKey: "home", blocks });

describe("validateDocument", () => {
  it("drops a productGrid id that is not a real catalog id, and logs it", () => {
    const result = validateDocument(
      doc([{ id: "g", type: "productGrid", layout: { x: 0, y: 0, w: 12, h: 6 }, props: { source: { kind: "ids", ids: ["1", "999"] } } }]),
      valid,
    );
    const grid = result.doc.blocks[0].props.source as { kind: string; ids: string[] };
    expect(grid.ids).toEqual(["1"]); // 999 dropped
    expect(result.dropped).toContainEqual({ blockId: "g", kind: "product", ref: "999" });
  });

  it("drops a block whose type is unknown", () => {
    const result = validateDocument(
      // @ts-expect-error invalid type on purpose
      doc([{ id: "x", type: "carousel", layout: { x: 0, y: 0, w: 1, h: 1 }, props: {} }]),
      valid,
    );
    expect(result.doc.blocks).toHaveLength(0);
    expect(result.dropped).toContainEqual({ blockId: "x", kind: "type", ref: "carousel" });
  });

  it("drops a block used on a doc kind it does not allow (collectionList on a template)", () => {
    const result = validateDocument(
      { kind: "template", pageKey: "pdp", blocks: [{ id: "c", type: "collectionList", layout: { x: 0, y: 0, w: 12, h: 1 }, props: {} }] },
      valid,
    );
    expect(result.doc.blocks).toHaveLength(0);
  });

  it("passes a clean document untouched", () => {
    const clean = doc([{ id: "h", type: "hero", layout: { x: 0, y: 0, w: 12, h: 2 }, props: { headline: "Hi", subhead: "yo" } }]);
    const result = validateDocument(clean, valid);
    expect(result.dropped).toHaveLength(0);
    expect(result.doc.blocks[0].props).toMatchObject({ headline: "Hi" });
  });

  it("reports a pdp template missing required functional blocks", () => {
    const result = validateDocument({ kind: "template", pageKey: "pdp", blocks: [] }, valid);
    expect(result.missingFunctional.sort()).toEqual(["addToCart", "price", "variantPicker"]);
  });

  it("a pdp template with all functional blocks reports nothing missing", () => {
    const block = (type: string) => ({ id: type, type, layout: { x: 0, y: 0, w: 6, h: 1 }, props: {} });
    const result = validateDocument(
      { kind: "template", pageKey: "pdp", blocks: [block("addToCart"), block("variantPicker"), block("price")] as never },
      valid,
    );
    expect(result.missingFunctional).toEqual([]);
  });
});
