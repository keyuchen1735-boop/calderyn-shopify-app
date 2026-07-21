// Corpus for the image-registry validator (spec D4 / shared D2.3 mechanism),
// reproducing the 2026-07-21 walkthrough's actual failure shapes: invented
// /storefront-recipes/candle-*.jpg paths that 404'd, the pantry template's
// donor food art surviving a candle store's first build behind rewritten alt
// text, and the legal placeholder bindings the renderer resolves.
import { describe, expect, it } from "vitest";
import {
  findImageRegistryViolations,
  imageRepairInstruction,
  unpublishableImageViolations,
} from "./image-registry.server";

const check = (files: Record<string, string>, opts?: { templateId?: string; firstBuild?: boolean }) =>
  findImageRegistryViolations({
    files,
    templateId: opts?.templateId ?? "ritual-almanac",
    firstBuild: opts?.firstBuild ?? true,
  });

describe("findImageRegistryViolations — walkthrough failure shapes", () => {
  it("flags an invented /storefront-recipes/ path as invented-path (walkthrough 404s)", () => {
    const out = check({ "home.html": '<img src="/storefront-recipes/candle-amber.jpg" alt="Amber candle">' });
    expect(out).toEqual([{ file: "home.html", path: "/storefront-recipes/candle-amber.jpg", reason: "invented-path" }]);
  });

  it("flags donor art surviving a FIRST build even with rewritten alt text", () => {
    const out = check({ "home.html": '<img src="/storefront-recipes/ritual-almanac/hero.webp" alt="Hand-poured candles">' });
    expect(out).toEqual([
      { file: "home.html", path: "/storefront-recipes/ritual-almanac/hero.webp", reason: "donor-art-on-first-build" },
    ]);
  });

  it("keeps donor art legal on edit turns (grandfathered for existing stores)", () => {
    const out = check(
      { "home.html": '<img src="/storefront-recipes/ritual-almanac/hero.webp">' },
      { firstBuild: false },
    );
    expect(out).toEqual([]);
  });

  it("flags another template's real art as foreign-template-path", () => {
    const out = check({ "home.html": '<img src="/storefront-recipes/room-modes/hero.webp">' });
    expect(out).toEqual([
      { file: "home.html", path: "/storefront-recipes/room-modes/hero.webp", reason: "foreign-template-path" },
    ]);
  });

  it("treats {{asset.hero}} as legal even when no asset exists (renderer falls back)", () => {
    const out = check({ "home.html": '<img src="{{asset.hero}}" alt="Hero">' });
    expect(out).toEqual([]);
  });

  it("flags an unbound asset placeholder when a first-build audit supplies the real asset keys", () => {
    const out = findImageRegistryViolations({
      files: { "home.html": '<img src="{{asset.hero}}">' },
      templateId: "ritual-almanac",
      firstBuild: true,
      availableAssetKeys: new Set(["collection"]),
    });
    expect(out).toEqual([
      {
        file: "home.html",
        path: "{{asset.hero}}",
        reason: "missing-required-asset-binding",
      },
    ]);
  });
});

describe("findImageRegistryViolations — allowed vocabulary", () => {
  it("accepts the full placeholder vocabulary and data: URIs", () => {
    const out = check({
      "home.html": [
        '<img src="{{product.image}}">',
        '<img src="{{store.logo}}">',
        '<img src="{{asset.img-abc123}}">',
        "<img src=\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3C/svg%3E\">",
      ].join("\n"),
    });
    expect(out).toEqual([]);
  });

  it("accepts self-hosted font urls and asset placeholders in CSS", () => {
    const out = check({
      "base.css": '@font-face{src:url(/storefront-fonts/inter-latin.woff2)}\n.hero{background-image:url("{{asset.hero}}")}',
    });
    expect(out).toEqual([]);
  });

  it("accepts collection/texture assets and data URIs regardless of scheme case", () => {
    const out = check({
      "home.html": [
        "<img SRC={{asset.collection}}>",
        "<img src='{{asset.texture}}'>",
        "<img src=DATA:image/svg+xml,%3Csvg%3E>",
      ].join(""),
    });
    expect(out).toEqual([]);
  });

  it("extracts quoted and unquoted src attributes case-insensitively", () => {
    const out = check({
      "home.html": [
        '<img SRC="/storefront-recipes/candle-upper.jpg">',
        "<img src='/storefront-recipes/candle-single.jpg'>",
        "<img src=/storefront-recipes/candle-bare.jpg>",
      ].join(""),
    });
    expect(out.map((violation) => violation.path)).toEqual([
      "/storefront-recipes/candle-upper.jpg",
      "/storefront-recipes/candle-single.jpg",
      "/storefront-recipes/candle-bare.jpg",
    ]);
  });

  it("checks every candidate in quoted and unquoted srcset attributes", () => {
    const out = check({
      "home.html": [
        '<img srcset="{{asset.collection}} 1x, /storefront-recipes/candle-wide.jpg 2x">',
        "<img SRCSET='{{product.image}} 320w, //evil.example/candle.jpg 640w'>",
        "<img srcset=/storefront-recipes/candle-a.jpg,/storefront-recipes/candle-b.jpg>",
      ].join(""),
    });
    expect(out.map((violation) => violation.path)).toEqual([
      "/storefront-recipes/candle-wide.jpg",
      "//evil.example/candle.jpg",
      "/storefront-recipes/candle-a.jpg",
      "/storefront-recipes/candle-b.jpg",
    ]);
  });

  it("rejects protocol-relative and absolute external image references", () => {
    const out = check({
      "home.html": '<img src="//cdn.example/x.jpg"><img src=https://cdn.example/y.jpg>',
    });
    expect(out.map((violation) => violation.path)).toEqual([
      "//cdn.example/x.jpg",
      "https://cdn.example/y.jpg",
    ]);
  });

  it("canonicalizes browser-equivalent CSS escapes before classification", () => {
    const out = check(
      {
        "base.css": [
          String.raw`.valid{background:url(\2f storefront-recipes\2f ritual-almanac\2f hero.webp)}`,
          String.raw`.external{background:url(https\3a \2f \2f evil.example\2f x.jpg)}`,
          String.raw`.invented{background:url(\2f storefront-recipes\2f candle-escaped.jpg)}`,
          String.raw`.binding{background:url(\7b \7b asset.texture\7d \7d )}`,
        ].join("\n"),
      },
      { firstBuild: false },
    );
    expect(out.map((violation) => violation.reason)).toEqual([
      "invented-path",
      "invented-path",
    ]);
    expect(out.map((violation) => violation.path)).toEqual([
      String.raw`https\3a \2f \2f evil.example\2f x.jpg`,
      String.raw`\2f storefront-recipes\2f candle-escaped.jpg`,
    ]);
  });

  it("rejects unknown placeholders and external urls", () => {
    const out = check({
      "home.html": '<img src="{{related.image}}"><img src="https://example.com/x.jpg">',
    });
    expect(out.map((violation) => violation.reason)).toEqual(["invented-path", "invented-path"]);
  });

  it("flags invented paths referenced from CSS url() with file attribution", () => {
    const out = check({ "home.css": ".hero{background:url(/storefront-recipes/candle-hero.jpg)}" });
    expect(out).toEqual([{ file: "home.css", path: "/storefront-recipes/candle-hero.jpg", reason: "invented-path" }]);
  });

  it("catches url() inside inline style attributes in html", () => {
    const out = check({ "home.html": '<section style="background:url(/images/banner.png)"></section>' });
    expect(out).toEqual([{ file: "home.html", path: "/images/banner.png", reason: "invented-path" }]);
  });

  it("ignores empty srcs, svg fragment refs, and non-document files", () => {
    const out = check({
      "home.html": '<img src=""><use href="#icon"/>',
      "home.css": ".x{clip-path:url(#clip)}",
      "notes.txt": '<img src="/storefront-recipes/fake.jpg">',
    });
    expect(out).toEqual([]);
  });

  it("dedupes repeated identical violations per file", () => {
    const src = '<img src="/storefront-recipes/candle-a.jpg">';
    const out = check({ "home.html": `${src}${src}${src}` });
    expect(out).toHaveLength(1);
  });
});

describe("unpublishableImageViolations", () => {
  it("blocks invented and foreign paths but never a store's own donor art", () => {
    const violations = check({
      "home.html": [
        '<img src="/storefront-recipes/candle-a.jpg">',
        '<img src="/storefront-recipes/room-modes/hero.webp">',
        '<img src="/storefront-recipes/ritual-almanac/hero.webp">',
      ].join(""),
    });
    const blocked = unpublishableImageViolations(violations);
    expect(blocked.map((violation) => violation.reason).sort()).toEqual(["foreign-template-path", "invented-path"]);
  });
});

describe("imageRepairInstruction", () => {
  it("is empty for a clean set and names each violation otherwise", () => {
    expect(imageRepairInstruction([])).toBe("");
    const out = imageRepairInstruction(check({
      "home.html": '<img src="/storefront-recipes/candle-a.jpg"><img src="/storefront-recipes/ritual-almanac/hero.webp">',
    }));
    expect(out).toContain("IMAGE AUDIT");
    expect(out).toContain("/storefront-recipes/candle-a.jpg");
    expect(out).toContain("donor template's own artwork");
    expect(out).toContain("Never keep it with rewritten alt text");
  });

  it("recommends honest image-free treatments for unavailable live bindings", () => {
    const violations = findImageRegistryViolations({
      files: {
        "home.html": '<img src="{{store.logo}}"><img src="{{product.image}}">',
      },
      templateId: "scratch",
      firstBuild: true,
      availableAssetKeys: new Set(),
      storeLogoAvailable: false,
      productImagesAvailable: false,
    });
    const out = imageRepairInstruction(violations);
    expect(out).toContain("typographic store-name treatment");
    expect(out).toContain("image-free card treatment");
    expect(out).not.toContain("generate");
  });
});
