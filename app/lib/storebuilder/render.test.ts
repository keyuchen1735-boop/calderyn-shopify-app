// app/lib/storebuilder/render.test.ts
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderBlocks } from "./render";
import type { Block, BlockDocument, RenderContext } from "./types";

const ctx: RenderContext = { data: { collections: [], productsByCollection: {}, productsById: {}, allProducts: [] } };
const wrap = (doc: BlockDocument) => renderToStaticMarkup(createElement("div", null, renderBlocks(doc, ctx)));

describe("renderBlocks", () => {
  it("renders blocks sorted top-to-bottom by layout.y", () => {
    const doc: BlockDocument = { kind: "singleton", pageKey: "home", blocks: [
      { id: "b", type: "richText", layout: { x: 0, y: 5, w: 12, h: 1 }, props: { text: "SECOND" } },
      { id: "a", type: "hero", layout: { x: 0, y: 0, w: 12, h: 2 }, props: { headline: "FIRST", subhead: "" } },
    ] };
    const html = wrap(doc);
    expect(html.indexOf("FIRST")).toBeLessThan(html.indexOf("SECOND"));
  });

  it("skips an unknown block type instead of throwing", () => {
    const doc = { kind: "singleton", pageKey: "home", blocks: [
      // @ts-expect-error invalid type on purpose
      { id: "x", type: "carousel", layout: { x: 0, y: 0, w: 1, h: 1 }, props: {} } satisfies Block,
      { id: "h", type: "hero", layout: { x: 0, y: 1, w: 12, h: 2 }, props: { headline: "OK", subhead: "" } },
    ] } as BlockDocument;
    expect(() => wrap(doc)).not.toThrow();
    expect(wrap(doc)).toContain("OK");
  });
});
