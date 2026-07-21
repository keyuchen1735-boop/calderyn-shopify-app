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
});
