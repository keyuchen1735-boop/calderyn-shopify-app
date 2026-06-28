import { describe, it, expect } from "vitest";
import { pushCreativeDraftKey, parsePushDraftCreative } from "../push-draft.server";
import type { CreativeInput } from "~/lib/screener/types";

const CREATIVE: CreativeInput = {
  imageUrl: "https://cdn.example.com/a.jpg",
  headline: "Summer Sale",
  primaryText: "50% off everything.",
  cta: "SHOP_NOW",
  destinationUrl: "https://shop.example.com/sale",
  audience: "",
};

describe("pushCreativeDraftKey", () => {
  it("is deterministic for the same campaign + variant", () => {
    expect(pushCreativeDraftKey("camp-1", CREATIVE)).toBe(pushCreativeDraftKey("camp-1", CREATIVE));
  });

  it("differs when the campaign differs", () => {
    expect(pushCreativeDraftKey("camp-1", CREATIVE)).not.toBe(pushCreativeDraftKey("camp-2", CREATIVE));
  });

  it("differs when any variant field differs", () => {
    const other = { ...CREATIVE, headline: "Winter Sale" };
    expect(pushCreativeDraftKey("camp-1", CREATIVE)).not.toBe(pushCreativeDraftKey("camp-1", other));
  });

  it("is independent of object key insertion order", () => {
    const reordered: CreativeInput = {
      audience: "",
      destinationUrl: "https://shop.example.com/sale",
      cta: "SHOP_NOW",
      primaryText: "50% off everything.",
      headline: "Summer Sale",
      imageUrl: "https://cdn.example.com/a.jpg",
    };
    expect(pushCreativeDraftKey("camp-1", reordered)).toBe(pushCreativeDraftKey("camp-1", CREATIVE));
  });

  it("is prefixed and a sha256 hex digest", () => {
    expect(pushCreativeDraftKey("camp-1", CREATIVE)).toMatch(/^push_creative_draft:[a-f0-9]{64}$/);
  });
});

describe("parsePushDraftCreative", () => {
  it("accepts a well-formed creative payload", () => {
    const res = parsePushDraftCreative({
      headline: "  Summer Sale ",
      primaryText: "50% off.",
      cta: "SHOP_NOW",
      destinationUrl: "https://shop.example.com/sale",
      imageUrl: "https://cdn.example.com/a.jpg",
      audience: "warm",
    });
    expect(res).toEqual({
      ok: true,
      creative: {
        headline: "Summer Sale",
        primaryText: "50% off.",
        cta: "SHOP_NOW",
        destinationUrl: "https://shop.example.com/sale",
        imageUrl: "https://cdn.example.com/a.jpg",
        audience: "warm",
      },
    });
  });

  it("defaults a blank cta to SHOP_NOW and null imageUrl", () => {
    const res = parsePushDraftCreative({
      headline: "H",
      primaryText: "P",
      destinationUrl: "https://shop.example.com/x",
    });
    expect(res).toMatchObject({ ok: true, creative: { cta: "SHOP_NOW", imageUrl: null, audience: "" } });
  });

  it("rejects a missing headline", () => {
    const res = parsePushDraftCreative({ primaryText: "P", destinationUrl: "https://x.com" });
    expect(res).toEqual({ ok: false, error: "missing_headline" });
  });

  it("rejects a missing/non-http destination url", () => {
    expect(parsePushDraftCreative({ headline: "H", destinationUrl: "" })).toEqual({
      ok: false,
      error: "missing_destination_url",
    });
    expect(parsePushDraftCreative({ headline: "H", destinationUrl: "javascript:alert(1)" })).toEqual({
      ok: false,
      error: "missing_destination_url",
    });
  });

  it("rejects a non-object body", () => {
    expect(parsePushDraftCreative(null)).toEqual({ ok: false, error: "invalid_creative" });
  });
});
