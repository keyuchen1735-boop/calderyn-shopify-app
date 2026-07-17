import { describe, expect, it } from "vitest";
import { editContext, fileContext, summarizeChanges } from "./context";
import type { DesignerStoreData } from "./types";

const product = (id: string, title: string): DesignerStoreData["products"][number] => ({
  id,
  handle: id,
  title,
  description: null,
  priceCents: 3400,
  compareAtPriceCents: null,
  available: true,
  imageUrl: null,
});

const data: DesignerStoreData = {
  storeName: "Peak & Pine Outfitters",
  tagline: "Recovery built for the miles ahead",
  logoUrl: null,
  products: [product("trail-recovery", "Trail Recovery Blend"), product("summit-electrolytes", "Summit Electrolytes")],
};

const files = {
  "base.css": ":root{--accent:#b5651d}",
  "home.html": '<h1>{{store.name}}</h1><img alt="Peakwell Supplements trail recovery">',
  "home.css": ".hero{padding:96px}",
};

describe("fileContext", () => {
  it("includes base.css plus the html+css for the route under discussion", () => {
    const out = fileContext(files, "home");
    expect(out).toContain("===== base.css =====");
    expect(out).toContain("===== home.html =====");
    expect(out).toContain("===== home.css =====");
    expect(out).toContain("--accent:#b5651d");
  });

  it("does not leak other routes' files", () => {
    const out = fileContext({ ...files, "product.html": "<h1>PDP</h1>" }, "home");
    expect(out).not.toContain("PDP");
  });
});

describe("editContext", () => {
  const out = editContext(data, "home", files);

  it("states the real store name and the page under discussion", () => {
    expect(out).toContain("Peak & Pine Outfitters");
    expect(out).toContain("home");
  });

  it("frames the files as the store's own current work, not pasted foreign code", () => {
    // The bug: the model read a fabricated 'Peakwell' brand baked into the
    // markup, decided the merchant pasted another store's code, and refused to
    // trust the files. Exact substrings so any rewording of the framing is a
    // deliberate diff here, not a silent weakening.
    expect(out).toContain("OWN current storefront files");
    expect(out).toContain("never code the merchant pasted from somewhere else");
  });

  it("tells the model to correct a stray foreign brand to the real store name", () => {
    // A leftover brand name in the markup is a mistake to fix, never a reason to
    // treat the store as belonging to someone else.
    expect(out).toContain("a stray leftover to correct");
    expect(out).toContain('to correct to "Peak & Pine Outfitters"');
    expect(out).toContain("never ask the merchant to paste or rebuild their files");
  });

  it("still carries the current file bodies for editing", () => {
    expect(out).toContain("Peakwell Supplements"); // the actual markup to fix
    expect(out).toContain("--accent:#b5651d");
  });
});

describe("summarizeChanges", () => {
  it("returns nothing when files are identical", () => {
    expect(summarizeChanges(files, files)).toEqual([]);
  });

  it("groups a route's html+css under one merchant-facing page label", () => {
    const before = { "home.html": "<h1>a</h1>", "home.css": ".x{}" };
    const after = { "home.html": "<h1>b</h1>\n<p>c</p>", "home.css": ".x{}\n.y{}" };
    const out = summarizeChanges(before, after);
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe("Home page");
    expect(out[0].added).toBeGreaterThan(0);
  });

  it("labels base.css as Site styles and counts removed lines", () => {
    const before = { "base.css": "a\nb\nc" };
    const after = { "base.css": "a" };
    const out = summarizeChanges(before, after);
    expect(out[0].label).toBe("Site styles");
    expect(out[0].removed).toBe(2);
    expect(out[0].added).toBe(0);
  });

  it("reports several changed surfaces at once", () => {
    const before = { "base.css": "a", "product.html": "<h1>x</h1>" };
    const after = { "base.css": "a\nb", "product.html": "<h1>y</h1>" };
    const labels = summarizeChanges(before, after).map((c) => c.label);
    expect(labels).toContain("Site styles");
    expect(labels).toContain("Product page");
  });

  it("treats an empty file as zero lines, not one", () => {
    // Filling a previously empty css doc is purely additive: no phantom -1.
    const out = summarizeChanges({ "home.css": "" }, { "home.css": ".hero{padding:96px}\n.grid{gap:16px}" });
    expect(out).toEqual([{ label: "Home page", added: 2, removed: 0 }]);
  });

  it("still reports a surface whose edit only reordered lines", () => {
    // "Move the trust row above the hero" swaps lines without adding any; the
    // card must still confirm the page was updated.
    const out = summarizeChanges({ "home.html": "<a/>\n<b/>" }, { "home.html": "<b/>\n<a/>" });
    expect(out).toEqual([{ label: "Home page", added: 0, removed: 0 }]);
  });
});
