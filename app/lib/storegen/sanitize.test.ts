// app/lib/storegen/sanitize.test.ts
import { describe, it, expect } from "vitest";
import { assembleDocument } from "./sanitize";
import type { BlockPlan } from "./block-plan";

const valid = { productIds: new Set(["p1"]), collectionHandles: new Set(["summer"]) };

describe("assembleDocument", () => {
  it("clamps out-of-range layout cells to the 12-col grid", () => {
    const plan: BlockPlan = { blocks: [{ type: "hero", props: { headline: "Hi" }, layout: { x: -3, y: 1, w: 99, h: 0 } }] };
    const doc = assembleDocument("home", "singleton", plan, valid).doc;
    expect(doc.blocks[0].layout).toMatchObject({ x: 0, w: 12, h: 1 });
    expect(doc.blocks[0].layout.x + doc.blocks[0].layout.w).toBeLessThanOrEqual(12);
  });

  it("drops blocks with fabricated catalog ids and logs them", () => {
    const plan: BlockPlan = { blocks: [{ type: "productGrid", props: { source: { kind: "ids", ids: ["p1", "ghost"] } }, layout: {} }] };
    const { doc, dropped } = assembleDocument("home", "singleton", plan, valid);
    expect((doc.blocks[0].props.source as { ids: string[] }).ids).toEqual(["p1"]);
    expect(dropped.some((d) => d.ref === "ghost")).toBe(true);
  });

  it("truncates over-long copy", () => {
    const plan: BlockPlan = { blocks: [{ type: "hero", props: { headline: "x".repeat(500) }, layout: {} }] };
    const doc = assembleDocument("home", "singleton", plan, valid).doc;
    expect((doc.blocks[0].props.headline as string).length).toBeLessThanOrEqual(120);
  });

  it("injects the required functional blocks on a PDP that omitted them", () => {
    const plan: BlockPlan = { blocks: [{ type: "productGallery", props: {}, layout: {} }] };
    const doc = assembleDocument("pdp", "template", plan, valid).doc;
    const types = doc.blocks.map((b) => b.type).sort();
    expect(types).toContain("addToCart");
    expect(types).toContain("variantPicker");
    expect(types).toContain("price");
  });

  it("assigns stable ids and produces a doc that survives validateDocument unchanged", () => {
    const plan: BlockPlan = { blocks: [{ type: "hero", props: { headline: "Hi" }, layout: {} }] };
    const { doc } = assembleDocument("home", "singleton", plan, valid);
    expect(doc.blocks[0].id).toBe("home-hero-0");
  });
});
