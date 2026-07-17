import { describe, expect, it } from "vitest";
import { ART_DIRECTIONS, artDirectionFor, DESIGNER_FONT_IDS, scratchSeedFiles } from "./direction.server";
import { DESIGNER_ROUTES } from "./convert.server";
import type { DesignerStoreData } from "./types";

const data: DesignerStoreData = {
  storeName: "Peak & Pine",
  tagline: "Built for the long trail",
  logoUrl: null,
  products: [],
};

describe("artDirectionFor", () => {
  it("is stable for the same shop id", () => {
    expect(artDirectionFor("shop-a").id).toBe(artDirectionFor("shop-a").id);
  });

  it("spreads different shops across directions", () => {
    const ids = new Set(
      ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"].map((s) => artDirectionFor(`shop-${s}`).id),
    );
    expect(ids.size).toBeGreaterThan(2);
  });

  it("only ever uses self-hosted fonts", () => {
    for (const direction of ART_DIRECTIONS) {
      expect(DESIGNER_FONT_IDS).toContain(direction.displayFont);
      expect(DESIGNER_FONT_IDS).toContain(direction.bodyFont);
    }
  });
});

describe("scratchSeedFiles", () => {
  const files = scratchSeedFiles(ART_DIRECTIONS[0], data);

  it("seeds base.css plus html+css for every designer route", () => {
    expect(files["base.css"]).toContain("@font-face");
    for (const route of DESIGNER_ROUTES) {
      expect(files[`${route}.html`]).toContain(`data-designer-route="${route}"`);
      expect(files).toHaveProperty(`${route}.css`);
    }
  });

  it("seeds only valid placeholder vocabulary", () => {
    const allowed = new Set([
      "{{store.name}}", "{{store.tagline}}", "{{collection.title}}", "{{cart.count}}",
      "{{#products}}", "{{/products}}", "{{product.url}}", "{{product.image}}",
      "{{product.title}}", "{{product.price}}", "{{product.availability}}",
    ]);
    for (const route of DESIGNER_ROUTES) {
      for (const token of files[`${route}.html`].match(/\{\{[^}]+\}\}/g) ?? []) {
        expect(allowed.has(token), `${route}: ${token}`).toBe(true);
      }
    }
  });

  it("dedupes the font face when display and body share a font", () => {
    const single = scratchSeedFiles(ART_DIRECTIONS.find((d) => d.displayFont === d.bodyFont)!, data);
    expect(single["base.css"].match(/@font-face/g)?.length).toBe(1);
  });
});
