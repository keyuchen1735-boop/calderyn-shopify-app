import { describe, it, expect } from "vitest";
import { mapAdListItem, summarizeTargeting, parseCreativeInput } from "../meta-creative.server";

describe("mapAdListItem", () => {
  it("maps a raw ad row to ScreenableAd", () => {
    const out = mapAdListItem({ id: "123", name: "Spring Ad", effective_status: "PAUSED" });
    expect(out).toEqual({ id: "123", name: "Spring Ad", effectiveStatus: "PAUSED" });
  });
  it("defaults missing name/status", () => {
    const out = mapAdListItem({ id: "9" });
    expect(out.name).toBe("(untitled ad)");
    expect(out.effectiveStatus).toBe("UNKNOWN");
  });
});

describe("summarizeTargeting", () => {
  it("flattens geo, age, gender and interests into a short string", () => {
    const s = summarizeTargeting({
      age_min: 25, age_max: 44, genders: [2],
      geo_locations: { countries: ["US", "CA"] },
      flexible_spec: [{ interests: [{ name: "Skincare" }, { name: "Beauty" }] }],
    });
    expect(s).toContain("US");
    expect(s).toContain("25–44");
    expect(s.toLowerCase()).toContain("women");
    expect(s).toContain("Skincare");
  });
  it("returns a neutral default when targeting is empty", () => {
    expect(summarizeTargeting({})).toBe("Broad / unspecified audience");
  });
});

describe("parseCreativeInput", () => {
  it("reads object_story_spec.link_data (the common shape)", () => {
    const raw = {
      creative: {
        object_story_spec: {
          link_data: {
            message: "Glass skin in 7 days.",
            name: "Try the serum",
            link: "https://shop.test/p/serum?utm_content=HYD-SERUM",
            call_to_action: { type: "SHOP_NOW", value: { link: "https://shop.test/p/serum" } },
          },
        },
        image_url: "https://img.test/c.jpg",
      },
      adset: { targeting: { age_min: 25, age_max: 44, geo_locations: { countries: ["US"] } } },
    };
    const out = parseCreativeInput(raw);
    expect(out.headline).toBe("Try the serum");
    expect(out.primaryText).toBe("Glass skin in 7 days.");
    expect(out.cta).toBe("SHOP_NOW");
    expect(out.destinationUrl).toBe("https://shop.test/p/serum?utm_content=HYD-SERUM");
    expect(out.imageUrl).toBe("https://img.test/c.jpg");
    expect(out.audience).toContain("US");
  });

  it("falls back to legacy top-level title/body and asset_feed_spec", () => {
    const legacy = parseCreativeInput({
      creative: { title: "Legacy headline", body: "Legacy body", image_url: "https://img.test/x.jpg", call_to_action_type: "LEARN_MORE", link_url: "https://shop.test/x" },
    });
    expect(legacy.headline).toBe("Legacy headline");
    expect(legacy.primaryText).toBe("Legacy body");
    expect(legacy.cta).toBe("LEARN_MORE");
    expect(legacy.destinationUrl).toBe("https://shop.test/x");

    const afs = parseCreativeInput({
      creative: {
        asset_feed_spec: {
          titles: [{ text: "AFS headline" }],
          bodies: [{ text: "AFS body" }],
          link_urls: [{ website_url: "https://shop.test/afs" }],
          call_to_action_types: ["BUY_NOW"],
        },
      },
    });
    expect(afs.headline).toBe("AFS headline");
    expect(afs.primaryText).toBe("AFS body");
    expect(afs.destinationUrl).toBe("https://shop.test/afs");
    expect(afs.cta).toBe("BUY_NOW");
  });

  it("never throws on a sparse/empty creative — returns empty-ish CreativeInput", () => {
    const out = parseCreativeInput({});
    expect(out.imageUrl).toBeNull();
    expect(out.headline).toBe("");
    expect(out.cta).toBe("SHOP_NOW");
    expect(out.audience).toBe("Broad / unspecified audience");
  });
});
