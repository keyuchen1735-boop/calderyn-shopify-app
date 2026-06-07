import { describe, it, expect } from "vitest";
import { parseLandingSite, clickIdPlatform } from "../parse";

describe("parseLandingSite", () => {
  it("extracts utm params and click ids from a relative landing URL", () => {
    const out = parseLandingSite(
      "/products/widget?utm_source=facebook&utm_medium=cpc&utm_campaign=spring&fbclid=ABC123",
    );
    expect(out.utm).toMatchObject({ utm_source: "facebook", utm_medium: "cpc", utm_campaign: "spring" });
    expect(out.clickIds).toEqual({ fbclid: "ABC123" });
  });

  it("handles absolute URLs and all three click-id kinds", () => {
    expect(parseLandingSite("https://shop.com/?gclid=G1").clickIds).toEqual({ gclid: "G1" });
    expect(parseLandingSite("https://shop.com/?ttclid=T1").clickIds).toEqual({ ttclid: "T1" });
  });

  it("returns empty for null / no query / malformed input, never throws", () => {
    expect(parseLandingSite(null)).toEqual({ utm: {}, clickIds: {} });
    expect(parseLandingSite("/plain-page")).toEqual({ utm: {}, clickIds: {} });
    expect(parseLandingSite("::::not a url::::")).toEqual({ utm: {}, clickIds: {} });
  });

  it("caps oversized values to 512 chars (sanitize untrusted input)", () => {
    const huge = "x".repeat(1000);
    const out = parseLandingSite(`/?utm_campaign=${huge}&fbclid=${huge}`);
    expect(out.utm.utm_campaign?.length).toBe(512);
    expect(out.clickIds.fbclid?.length).toBe(512);
  });

  it("ignores empty param values", () => {
    expect(parseLandingSite("/?utm_source=&fbclid=")).toEqual({ utm: {}, clickIds: {} });
  });
});

describe("clickIdPlatform", () => {
  it("maps each click-id kind to its platform", () => {
    expect(clickIdPlatform("fbclid")).toBe("meta");
    expect(clickIdPlatform("gclid")).toBe("google");
    expect(clickIdPlatform("ttclid")).toBe("tiktok");
  });
});
