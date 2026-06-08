import { describe, it, expect } from "vitest";
import { clampSpend, parseCreativeForm } from "../../../routes/app.screener";
import { isMetaSubmit } from "../../../routes/app.screener";

describe("clampSpend", () => {
  it("clamps to [MIN,MAX] and defaults non-numbers", () => {
    expect(clampSpend("50000")).toBe(50000);
    expect(clampSpend("0")).toBe(1000);
    expect(clampSpend("99999999")).toBe(10_000_000);
    expect(clampSpend(null)).toBe(50000);
  });
});

describe("parseCreativeForm", () => {
  it("pulls fields and trims, defaulting empties", () => {
    const fd = new FormData();
    fd.set("headline", "  Hi  ");
    fd.set("primaryText", "body");
    fd.set("cta", "SHOP_NOW");
    fd.set("destinationUrl", "https://x.test/p");
    fd.set("audience", "women 25-44");
    fd.set("imageUrl", "");
    const out = parseCreativeForm(fd);
    expect(out.headline).toBe("Hi");
    expect(out.imageUrl).toBeNull();
    expect(out.cta).toBe("SHOP_NOW");
  });
});

describe("isMetaSubmit", () => {
  it("detects the meta source mode + ad id", () => {
    const fd = new FormData();
    fd.set("source", "meta_ad");
    fd.set("metaAdId", "ad-7");
    expect(isMetaSubmit(fd)).toEqual({ metaAdId: "ad-7" });
  });
  it("returns null for manual submits", () => {
    const fd = new FormData();
    expect(isMetaSubmit(fd)).toBeNull();
  });
  it("returns null when meta mode lacks an ad id", () => {
    const fd = new FormData();
    fd.set("source", "meta_ad");
    expect(isMetaSubmit(fd)).toBeNull();
  });
});
