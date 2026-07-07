import { describe, expect, it } from "vitest";
import { verifyGeneratedDocs } from "./verify";
import type { BlockDocument } from "~/lib/storebuilder/types";
import type { StorefrontLinkSet } from "~/lib/storefront/links";

const VALID: StorefrontLinkSet = {
  productHandles: new Set(["p1"]),
  collectionHandles: new Set(["summer"]),
};

const raw = (html: string): BlockDocument => ({
  kind: "singleton",
  pageKey: "home",
  blocks: [{ id: "b1", type: "rawHtml", props: { html }, layout: { x: 0, y: 0, w: 12, h: 12 } }],
});

describe("verifyGeneratedDocs", () => {
  it("passes resolvable internal links and counts them", () => {
    const docs = {
      home: raw('<div class="ai-store"><a href="/storefront">all</a><a href="/storefront/collections/summer">c</a></div>'),
    };
    const { docs: out, report } = verifyGeneratedDocs(docs, VALID);
    expect(report.checkedLinks).toBe(2);
    expect(report.fixedLinks).toBe(0);
    expect(out.home).toEqual(docs.home);
  });

  it("rewrites dead internal links to the shop home and counts the fix", () => {
    const docs = {
      home: raw('<div class="ai-store"><a href="/storefront/collections/no-such">x</a><a href="/checkout">y</a></div>'),
    };
    const { docs: out, report } = verifyGeneratedDocs(docs, VALID);
    const html = (out.home.blocks[0].props as { html: string }).html;
    expect(html).not.toContain("no-such");
    expect(html).not.toContain("/checkout");
    expect(html.match(/href="\/storefront"/g)).toHaveLength(2);
    expect(report.fixedLinks).toBe(2);
  });

  it("leaves external and mailto links alone but counts them as warnings", () => {
    const docs = {
      home: raw('<div class="ai-store"><a href="https://example.com">e</a><a href="mailto:a@b.c">m</a></div>'),
    };
    const { docs: out, report } = verifyGeneratedDocs(docs, VALID);
    expect((out.home.blocks[0].props as { html: string }).html).toContain("https://example.com");
    expect(report.externalLinks).toBe(2);
    expect(report.fixedLinks).toBe(0);
  });

  it("fixes button block hrefs across non-home docs too", () => {
    const docs = {
      collection: {
        kind: "template",
        pageKey: "collection",
        blocks: [{ id: "c1", type: "button", props: { label: "Go", href: "/storefront/products/ghost" }, layout: { x: 0, y: 0, w: 3, h: 1 } }],
      } as BlockDocument,
    };
    const { docs: out, report } = verifyGeneratedDocs(docs, VALID);
    expect((out.collection.blocks[0].props as { href: string }).href).toBe("/storefront");
    expect(report.fixedLinks).toBe(1);
  });

  it("strips motion attributes whose spec the runtime would silently reject", () => {
    const bad = '{"trigger":"inview","targets":".x","from":{"bogus":1}}';
    const good = '{"trigger":"inview","targets":".x","from":{"opacity":0},"to":{"opacity":1}}';
    const docs = {
      home: raw(`<div class="ai-store"><section data-fx-motion='${bad}'>a</section><section data-fx-motion='${good}'>b</section></div>`),
    };
    const { docs: out, report } = verifyGeneratedDocs(docs, VALID);
    const html = (out.home.blocks[0].props as { html: string }).html;
    expect(report.strippedMotion).toBe(1);
    expect((html.match(/data-fx-motion/g) ?? []).length).toBe(1);
    expect(html).toContain("opacity");
  });

  it("reports a hollow home (no meaningful markup) as a warning", () => {
    const docs = { home: raw('<div class="ai-store"><p>hi</p></div>') };
    const { report } = verifyGeneratedDocs(docs, VALID);
    expect(report.warnings.some((w) => /short|hollow|sparse/i.test(w))).toBe(true);
  });

  it("returns zero-activity report for docs without links or fx", () => {
    const docs = { pdp: raw('<div class="ai-store"><h1>x</h1></div>'.repeat(1)) };
    const { report } = verifyGeneratedDocs(docs, VALID);
    expect(report.checkedLinks).toBe(0);
    expect(report.strippedMotion).toBe(0);
  });
});
