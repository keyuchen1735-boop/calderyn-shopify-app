import { describe, expect, it } from "vitest";
import { spliceCatalogBlocks } from "./hybrid";
import { sanitizeStoreHtml } from "~/lib/storebuilder/sanitize-html.server";
import type { ValidIds } from "~/lib/storebuilder/validate";

const VALID: ValidIds = {
  productIds: new Set(["11111111-1111-1111-1111-111111111111"]),
  collectionHandles: new Set(["diagnostics", "monitoring"]),
};

const STYLE = "<style>.ai-store .hero{color:red}</style>";
const wrap = (inner: string) => `<div class="ai-store">${STYLE}${inner}</div>`;

describe("spliceCatalogBlocks", () => {
  it("returns one rawHtml block when there are no markers", () => {
    const html = wrap('<section class="hero">hi</section>');
    const blocks = spliceCatalogBlocks(html, VALID);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("rawHtml");
    expect((blocks[0].props as { html: string }).html).toBe(html);
  });

  it("splices a products marker into a productGrid between re-wrapped rawHtml segments", () => {
    const html = wrap(
      '<section class="hero">hero</section>' +
        '<div data-cd-products="diagnostics" data-cd-heading="Featured devices"></div>' +
        '<section class="closer">closer</section>',
    );
    const blocks = spliceCatalogBlocks(html, VALID);
    expect(blocks.map((b) => b.type)).toEqual(["rawHtml", "productGrid", "rawHtml"]);
    const grid = blocks[1].props as { source: { kind: string; handle?: string }; heading: string };
    expect(grid.source).toEqual({ kind: "collection", handle: "diagnostics" });
    expect(grid.heading).toBe("Featured devices");
    // Every rawHtml segment stays a self-contained .ai-store fragment with its scoped style,
    // so the model's CSS keeps applying to sections after the splice point.
    for (const b of [blocks[0], blocks[2]]) {
      const h = (b.props as { html: string }).html;
      expect(h.startsWith('<div class="ai-store">' + STYLE)).toBe(true);
      expect(h.endsWith("</div>")).toBe(true);
    }
    expect((blocks[2].props as { html: string }).html).toContain("closer");
  });

  it('maps "all" and unknown collection handles to the all-products source', () => {
    const html = wrap(
      '<div data-cd-products="all" data-cd-heading="Everything"></div>' +
        "<section>mid</section>" +
        '<div data-cd-products="no-such-handle" data-cd-heading="Ghost"></div>',
    );
    const blocks = spliceCatalogBlocks(html, VALID);
    const grids = blocks.filter((b) => b.type === "productGrid");
    expect(grids).toHaveLength(2);
    for (const g of grids) expect((g.props as { source: { kind: string } }).source).toEqual({ kind: "all" });
  });

  it("splices a collections marker into a collectionList block", () => {
    const html = wrap('<section>top</section><div data-cd-collections="" data-cd-heading="Browse by specialty"></div>');
    const blocks = spliceCatalogBlocks(html, VALID);
    expect(blocks.map((b) => b.type)).toEqual(["rawHtml", "collectionList"]);
    expect((blocks[1].props as { heading: string }).heading).toBe("Browse by specialty");
  });

  it("drops empty segments instead of emitting empty rawHtml blocks", () => {
    const html = wrap('<div data-cd-products="all" data-cd-heading="Shop"></div>');
    const blocks = spliceCatalogBlocks(html, VALID);
    expect(blocks.map((b) => b.type)).toEqual(["productGrid"]);
  });

  it("caps catalog blocks at three and strips further markers", () => {
    const html = wrap(
      "<p>a</p>" +
        '<div data-cd-products="all" data-cd-heading="1"></div><p>b</p>' +
        '<div data-cd-collections="" data-cd-heading="2"></div><p>c</p>' +
        '<div data-cd-products="all" data-cd-heading="3"></div><p>d</p>' +
        '<div data-cd-products="all" data-cd-heading="4"></div><p>e</p>',
    );
    const blocks = spliceCatalogBlocks(html, VALID);
    expect(blocks.filter((b) => b.type !== "rawHtml")).toHaveLength(3);
    const joined = blocks
      .filter((b) => b.type === "rawHtml")
      .map((b) => (b.props as { html: string }).html)
      .join("");
    expect(joined).not.toContain("data-cd-products");
    expect(joined).toContain("<p>d</p>");
    expect(joined).toContain("<p>e</p>");
  });

  it("decodes entities in headings and caps them at 80 chars", () => {
    const html = wrap(`<div data-cd-products="all" data-cd-heading="Tools &amp; Care ${"x".repeat(100)}"></div>`);
    const blocks = spliceCatalogBlocks(html, VALID);
    const heading = (blocks[0].props as { heading: string }).heading;
    expect(heading.startsWith("Tools & Care")).toBe(true);
    expect(heading.length).toBeLessThanOrEqual(80);
  });

  it("falls back to a single rawHtml block when the ai-store wrapper is not recognized", () => {
    const html = '<section>no wrapper</section><div data-cd-products="all" data-cd-heading="x"></div>';
    const blocks = spliceCatalogBlocks(html, VALID);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("rawHtml");
  });

  it("accepts valueless marker attributes — the sanitizer serializes empty values that way", () => {
    // The model emits data-cd-collections=""; sanitize-html re-serializes the empty
    // value as a bare attribute. Both forms must splice.
    const bare = wrap('<section>top</section><div data-cd-collections data-cd-heading="Browse"></div>');
    expect(spliceCatalogBlocks(bare, VALID).map((b) => b.type)).toEqual(["rawHtml", "collectionList"]);
    const roundTripped = sanitizeStoreHtml(wrap('<section>top</section><div data-cd-collections="" data-cd-heading="Browse"></div>'));
    expect(spliceCatalogBlocks(roundTripped, VALID).map((b) => b.type)).toEqual(["rawHtml", "collectionList"]);
  });

  it("markers survive the real sanitizer and still splice afterwards", () => {
    const raw = wrap(
      '<section class="hero">hero</section>' +
        '<div data-cd-products="monitoring" data-cd-heading="Monitors &amp; sensors"></div>' +
        "<section>end</section>",
    );
    const clean = sanitizeStoreHtml(raw);
    const blocks = spliceCatalogBlocks(clean, VALID);
    expect(blocks.map((b) => b.type)).toEqual(["rawHtml", "productGrid", "rawHtml"]);
    expect((blocks[1].props as { heading: string }).heading).toBe("Monitors & sensors");
  });

  it("assigns sequential stacked layouts spanning the full grid", () => {
    const html = wrap('<p>a</p><div data-cd-products="all" data-cd-heading="Shop"></div><p>b</p>');
    const blocks = spliceCatalogBlocks(html, VALID);
    const ys = blocks.map((b) => b.layout.y);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
    expect(new Set(ys).size).toBe(ys.length);
    for (const b of blocks) {
      expect(b.layout.x).toBe(0);
      expect(b.layout.w).toBe(12);
      expect(b.id).toBeTruthy();
    }
  });
});
