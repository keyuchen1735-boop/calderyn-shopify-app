import { describe, it, expect } from "vitest";
import { clampSpend, parseCreativeForm } from "../../../routes/app.screener";

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
