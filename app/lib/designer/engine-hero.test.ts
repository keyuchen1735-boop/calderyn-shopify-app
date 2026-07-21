// Mandatory hero (spec D4): the first-build instruction's hero branch is
// contract — it must ALWAYS commit to a hero (asset, product photography, or
// a deliberate typographic treatment) and never fall through to the empty
// string that let gray placeholder heroes ship. Same exact-substring style as
// engine-prompt.test.ts: a reworded rule is a deliberate diff, never drift.
import { describe, expect, it } from "vitest";
import { firstBuildInstruction, firstBuildRouteImageAudit, pickExistingHeroSource } from "./engine.server";
import { renderDesignerBody } from "./render.server";
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

  it("uses typographic mode when no adopted/generated hero binding exists, even if product cards have photos", () => {
    const out = instruction({ heroAssetUrl: null, hasProductImagery: true });
    expect(out).toContain("typographic/color hero");
    expect(out).not.toContain("build the hero around {{product.image}}");
  });

  it("demands a deliberate typographic hero when no imagery exists at all", () => {
    const out = instruction({ heroAssetUrl: null, hasProductImagery: false });
    expect(out).toContain("typographic/color hero");
    expect(out).toContain("no gray placeholder art");
  });

  it("requires genuinely image-free product cards when catalog photography is incomplete", () => {
    const out = firstBuildInstruction({
      brief: "A store for hand-poured maple candles",
      route: "collection",
      mode: "scratch",
      templateId: "scratch",
      direction: ART_DIRECTIONS[0],
      donePages: [],
      heroAssetUrl: null,
      productImagesAvailable: false,
    });

    expect(out).toContain("remove the media region entirely");
    expect(out).toContain("no reserved aspect-ratio box");
    expect(out).toContain("no gradient, initials, icon, or illustration stand-in");
  });

  it("always emits a hero instruction — the empty-string branch is gone", () => {
    for (const variant of [
      { heroAssetUrl: "https://cdn.example/hero.jpg" },
      { heroAssetUrl: null, hasProductImagery: true },
      { heroAssetUrl: null, hasProductImagery: false },
      {},
    ]) {
      expect(instruction(variant)).toMatch(/\{\{asset\.hero\}\}|typographic/);
    }
  });
});

describe("first-build hero outcome", () => {
  it("fails the route audit when an unbound hero would render the neutral image", () => {
    const files = {
      "base.css": "",
      "home.html": '<section class="hero"><img src="{{asset.hero}}"></section>',
      "home.css": "",
    };
    const rendered = renderDesignerBody({
      html: files["home.html"],
      css: files["home.css"],
      data: data({ products: [product("https://owned.example/card.jpg")], assets: {} }),
    });
    expect(rendered.bodyHtml).toContain("data:image/svg+xml");

    expect(firstBuildRouteImageAudit({
      files,
      route: "home",
      templateId: "scratch",
      availableAssetKeys: new Set(),
    })).toEqual([
      expect.objectContaining({
        file: "home.html",
        path: "{{asset.hero}}",
        reason: "missing-required-asset-binding",
      }),
    ]);
  });

  it("allows a real adopted/generated hero binding", () => {
    expect(firstBuildRouteImageAudit({
      files: {
        "base.css": "",
        "home.html": '<img src="{{asset.hero}}">',
        "home.css": "",
      },
      route: "home",
      templateId: "scratch",
      availableAssetKeys: new Set(["hero"]),
    })).toEqual([]);
  });

  it("rejects a missing store logo after proving it renders neutral artwork", () => {
    const files = {
      "base.css": "",
      "home.html": '<img src="{{store.logo}}">',
      "home.css": "",
    };
    const storeData = data({ logoUrl: null });
    expect(renderDesignerBody({ html: files["home.html"], css: "", data: storeData }).bodyHtml)
      .toContain("data:image/svg+xml");
    expect(firstBuildRouteImageAudit({
      files,
      route: "home",
      templateId: "scratch",
      availableAssetKeys: new Set(),
      storeLogoAvailable: false,
      productImagesAvailable: false,
    })).toEqual([
      expect.objectContaining({ path: "{{store.logo}}", reason: "missing-required-asset-binding" }),
    ]);
  });

  it("rejects product imagery unless a nonempty catalog is entirely image-ready", () => {
    const files = {
      "base.css": "",
      "home.html": '{{#products}}<img src="{{product.image}}">{{/products}}',
      "home.css": "",
    };
    const storeData = data({ products: [product("https://owned.example/ready.jpg"), product(null)] });
    expect(renderDesignerBody({ html: files["home.html"], css: "", data: storeData }).bodyHtml)
      .toContain("data:image/svg+xml");
    expect(firstBuildRouteImageAudit({
      files,
      route: "home",
      templateId: "scratch",
      availableAssetKeys: new Set(),
      storeLogoAvailable: false,
      productImagesAvailable: false,
    })).toEqual([
      expect.objectContaining({ path: "{{product.image}}", reason: "missing-required-asset-binding" }),
    ]);
  });

  it("accepts a real logo and an entirely image-ready nonempty catalog", () => {
    const files = {
      "base.css": "",
      "home.html": '<img src="{{store.logo}}">{{#products}}<img src="{{product.image}}">{{/products}}',
      "home.css": "",
    };
    const storeData = data({
      logoUrl: "https://owned.example/logo.jpg",
      products: [product("https://owned.example/one.jpg"), product("https://owned.example/two.jpg")],
    });
    const rendered = renderDesignerBody({ html: files["home.html"], css: "", data: storeData });
    expect(rendered.bodyHtml).toContain("https://owned.example/logo.jpg");
    expect(rendered.bodyHtml).toContain("https://owned.example/one.jpg");
    expect(rendered.bodyHtml).toContain("https://owned.example/two.jpg");
    expect(rendered.bodyHtml).not.toContain("data:image/svg+xml");

    expect(firstBuildRouteImageAudit({
      files,
      route: "home",
      templateId: "scratch",
      availableAssetKeys: new Set(),
      storeLogoAvailable: true,
      productImagesAvailable: true,
    })).toEqual([]);
  });
});

describe("firstBuildInstruction donor-art replacement contract (D4)", () => {
  const templateBuild = firstBuildInstruction({
    brief: "A store for hand-poured maple candles",
    route: "home",
    mode: "template",
    templateId: "ritual-almanac",
    direction: ART_DIRECTIONS[0],
    donePages: [],
    heroAssetUrl: "https://cdn.example/hero.jpg",
  });

  it("names the donor template's real art paths explicitly", () => {
    expect(templateBuild).toContain("/storefront-recipes/ritual-almanac/hero.webp");
    expect(templateBuild).toContain("exactly these files");
  });

  it("requires replace-or-remove and forbids re-captioning donor art", () => {
    expect(templateBuild).toContain("replace every reference");
    expect(templateBuild).toContain("never re-caption it with this store's alt text");
  });

  it("carries no donor rule on scratch builds (no donor template exists)", () => {
    const scratch = firstBuildInstruction({
      brief: "A store for hand-poured maple candles",
      route: "home",
      mode: "scratch",
      templateId: "scratch",
      direction: ART_DIRECTIONS[0],
      donePages: [],
      heroAssetUrl: null,
    });
    expect(scratch).not.toContain("exactly these files");
    expect(scratch).not.toContain("/storefront-recipes/");
  });
});
