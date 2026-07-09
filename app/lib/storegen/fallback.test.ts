// app/lib/storegen/fallback.test.ts
import { describe, it, expect } from "vitest";
import { fallbackDoc, voiceVariantIndex } from "./fallback";
import { validateDocument } from "~/lib/storebuilder/validate";

const valid = { productIds: new Set<string>(), collectionHandles: new Set<string>() };

describe("fallbackDoc", () => {
  it("home with no catalog → a self-contained hollow store (hero, CTA, features, story, CTA), validates clean", () => {
    const doc = fallbackDoc("home", { storeName: "Acme", tagline: "Go" });
    expect(doc.blocks.map((b) => b.type)).toEqual(["hero", "button", "featureRow", "richText", "button"]);
    // Real value props stand in for the missing catalog — never an empty product grid.
    const features = doc.blocks.find((b) => b.type === "featureRow")!.props as { items: unknown[] };
    expect(features.items.length).toBeGreaterThanOrEqual(3);
    expect(validateDocument(doc, valid).dropped).toHaveLength(0);
  });
  it("pdp → gallery + price + variantPicker + addToCart (buy-path complete)", () => {
    const doc = fallbackDoc("pdp", { storeName: "Acme", tagline: "" });
    const types = doc.blocks.map((b) => b.type);
    for (const t of ["productGallery", "price", "variantPicker", "addToCart"]) expect(types).toContain(t);
    expect(validateDocument(doc, valid).missingFunctional).toEqual([]);
  });
  it("collection → collectionGrid template", () => {
    const doc = fallbackDoc("collection", { storeName: "Acme", tagline: "" });
    expect(doc.kind).toBe("template");
    expect(doc.blocks.map((b) => b.type)).toContain("collectionGrid");
  });

  describe("v2 catalog-aware home composition", () => {
    const brand = { storeName: "Acme", tagline: "" };
    const oneCollection = {
      products: [{ title: "Cotton Tee" }],
      collections: [{ handle: "summer", title: "Summer" }],
      vibe: "minimal" as const,
    };

    it("composes hero, CTA, collection-sourced grid, story and closing CTA — all catalog refs valid", () => {
      const doc = fallbackDoc("home", brand, oneCollection);
      expect(doc.blocks.map((b) => b.type)).toEqual([
        "hero", "button", "productGrid", "richText", "button",
      ]);
      const grid = doc.blocks.find((b) => b.type === "productGrid")!;
      expect(grid.props.source).toEqual({ kind: "collection", handle: "summer" });
      // Benefit-led heading names the real collection, never the generic "Products".
      expect(grid.props.heading).not.toBe("Products");
      const valid2 = { productIds: new Set(["p1"]), collectionHandles: new Set(["summer"]) };
      expect(validateDocument(doc, valid2).dropped).toHaveLength(0);
    });

    it("adds a collectionList only once there are 2+ collections", () => {
      const one = fallbackDoc("home", brand, oneCollection);
      expect(one.blocks.some((b) => b.type === "collectionList")).toBe(false);

      const two = fallbackDoc("home", brand, {
        ...oneCollection,
        collections: [{ handle: "summer", title: "Summer" }, { handle: "winter", title: "Winter" }],
      });
      expect(two.blocks.map((b) => b.type)).toEqual([
        "hero", "button", "productGrid", "richText", "collectionList", "button",
      ]);
    });

    it("sources the grid from `all` and names the top product when there is no collection", () => {
      const doc = fallbackDoc("home", brand, { products: [{ title: "Cotton Tee" }], vibe: "minimal" });
      const grid = doc.blocks.find((b) => b.type === "productGrid")!;
      expect(grid.props.source).toEqual({ kind: "all" });
      expect(grid.props.heading).toContain("Cotton Tee");
    });

    it("uses the first available product image as the hero background", () => {
      const doc = fallbackDoc("home", brand, {
        products: [{ title: "Cotton Tee", imageUrl: "/i/tee.jpg" }],
        collections: [{ handle: "summer", title: "Summer" }],
        vibe: "minimal",
      });
      const hero = doc.blocks.find((b) => b.type === "hero")!;
      expect((hero.props as { imageUrl?: string }).imageUrl).toBe("/i/tee.jpg");
    });

    it("leaves the hero image empty when no product carries imagery", () => {
      const doc = fallbackDoc("home", brand, { products: [{ title: "Cotton Tee" }], vibe: "minimal" });
      const hero = doc.blocks.find((b) => b.type === "hero")!;
      expect((hero.props as { imageUrl?: string }).imageUrl ?? "").toBe("");
    });

    it("gives each vibe a distinct voice over the same catalog nouns", () => {
      const headline = (vibe: "minimal" | "bold" | "warm") =>
        (fallbackDoc("home", brand, { ...oneCollection, vibe }).blocks[0].props as { headline: string }).headline;
      const minimal = headline("minimal");
      const bold = headline("bold");
      const warm = headline("warm");
      expect(new Set([minimal, bold, warm]).size).toBe(3); // three distinct voices, not one template
    });

    it("varies the voice across store names but stays stable for the same name", () => {
      // Cover both variants without hardcoding which name hashes where.
      const names = ["Acme", "Birch & Vine", "Copperline", "Driftwood", "Ember Goods"];
      const byVariant = new Map(names.map((n) => [voiceVariantIndex(n), n]));
      expect(byVariant.size).toBeGreaterThan(1); // two different names can get different voices
      const headline = (storeName: string) =>
        (fallbackDoc("home", { storeName, tagline: "" }, oneCollection).blocks[0].props as { headline: string }).headline;
      const [a, b] = [...byVariant.values()];
      expect(headline(a)).not.toBe(headline(b)); // different variant, different copy
      expect(headline(a)).toBe(headline(a)); // same name, same copy on every run
      // Both variants still template over the real catalog noun, never a generic heading.
      for (const n of [a, b]) {
        const grid = fallbackDoc("home", { storeName: n, tagline: "" }, oneCollection).blocks.find((bl) => bl.type === "productGrid")!;
        expect(grid.props.heading).toContain("Summer");
      }
    });

    it("never writes clichés and stays within the copy bounds", () => {
      const doc = fallbackDoc("home", brand, oneCollection);
      const hero = doc.blocks[0].props as { headline: string; subhead: string };
      expect(hero.headline.toLowerCase()).not.toContain("welcome to our store");
      expect(hero.headline.length).toBeLessThanOrEqual(120);
      expect(hero.subhead.length).toBeLessThanOrEqual(200);
      const story = doc.blocks.find((b) => b.type === "richText")!.props as { html: string };
      expect(story.html.length).toBeLessThanOrEqual(2000);
      for (const b of doc.blocks.filter((b) => b.type === "button")) {
        expect((b.props as { label: string }).label.length).toBeLessThanOrEqual(40);
      }
    });
  });
});
