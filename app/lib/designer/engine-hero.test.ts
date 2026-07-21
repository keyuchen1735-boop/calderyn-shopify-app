// Mandatory hero (spec D4): the first-build instruction's hero branch is
// contract — it must ALWAYS commit to a hero (asset, product photography, or
// a deliberate typographic treatment) and never fall through to the empty
// string that let gray placeholder heroes ship. Same exact-substring style as
// engine-prompt.test.ts: a reworded rule is a deliberate diff, never drift.
import { describe, expect, it } from "vitest";
import { firstBuildInstruction, pickExistingHeroSource } from "./engine.server";
import { ART_DIRECTIONS } from "./direction.server";
import type { DesignerStoreData } from "./types";

const product = (imageUrl: string | null): DesignerStoreData["products"][number] => ({
  id: "p1",
  handle: "cedar-smoke",
  title: "Cedar & Smoke",
  description: null,
  priceCents: 2400,
  compareAtPriceCents: null,
  available: true,
  imageUrl,
});

const data = (overrides: Partial<DesignerStoreData>): DesignerStoreData => ({
  storeName: "Maple & Wick Candle Co.",
  tagline: null,
  logoUrl: null,
  products: [],
  ...overrides,
});

describe("pickExistingHeroSource", () => {
  it("prefers the first product photo (merchant media or ready generated asset)", () => {
    const out = pickExistingHeroSource(data({
      products: [product(null), product("https://cdn.example/cedar.jpg")],
      logoUrl: "https://cdn.example/logo.png",
    }));
    expect(out).toBe("https://cdn.example/cedar.jpg");
  });

  it("falls back to the store logo when no product has a photo", () => {
    const out = pickExistingHeroSource(data({ products: [product(null)], logoUrl: "https://cdn.example/logo.png" }));
    expect(out).toBe("https://cdn.example/logo.png");
  });

  it("returns null when the shop genuinely has no usable imagery", () => {
    expect(pickExistingHeroSource(data({ products: [product(null)] }))).toBeNull();
    expect(pickExistingHeroSource(data({ products: [product("")], logoUrl: "" }))).toBeNull();
  });
});

describe("firstBuildInstruction hero branch", () => {
  const instruction = (hero: { heroAssetUrl?: string | null; hasProductImagery?: boolean }) =>
    firstBuildInstruction({
      brief: "A store for hand-poured maple candles",
      route: "home",
      mode: "template",
      templateId: "ritual-almanac",
      direction: ART_DIRECTIONS[0],
      donePages: [],
      ...hero,
    });

  it("binds {{asset.hero}} when a hero asset exists", () => {
    const out = instruction({ heroAssetUrl: "https://cdn.example/hero.jpg" });
    expect(out).toContain("{{asset.hero}}");
    expect(out).toContain("prefer it over template art for the hero");
  });

  it("builds the hero around {{product.image}} when only product photos exist", () => {
    const out = instruction({ heroAssetUrl: null, hasProductImagery: true });
    expect(out).toContain("{{product.image}}");
    expect(out).toContain("never a gray placeholder");
  });

  it("demands a deliberate typographic hero when no imagery exists at all", () => {
    const out = instruction({ heroAssetUrl: null, hasProductImagery: false });
    expect(out).toContain("typographic/color hero");
    expect(out).toContain("no gray placeholder art");
  });

  it("always emits a hero instruction — the empty-string branch is gone", () => {
    for (const variant of [
      { heroAssetUrl: "https://cdn.example/hero.jpg" },
      { heroAssetUrl: null, hasProductImagery: true },
      { heroAssetUrl: null, hasProductImagery: false },
      {},
    ]) {
      expect(instruction(variant)).toMatch(/\{\{asset\.hero\}\}|\{\{product\.image\}\}|typographic/);
    }
  });
});
