import { describe, it, expect, vi } from "vitest";

// These route modules eagerly construct the Shopify app at import (shopify.server
// calls shopifyApp({ appUrl }) at module load), which throws "empty appUrl" when
// SHOPIFY_APP_URL is unset — e.g. in CI. The helpers under test don't touch
// authenticate, so stub shopify.server like the other route tests do.
vi.mock("../../../shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "acme.myshopify.com" } }) },
}));

import { clampSpend, parseCreativeForm, isMetaSubmit } from "../../../routes/app.screener";
import { parseScoreForm } from "../../../routes/app.campaigns.$campaignId.score";
import { DEFAULT_SPEND_CENTS } from "../types";

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

describe("parseScoreForm", () => {
  function form(entries: Record<string, string>): FormData {
    const fd = new FormData();
    for (const [k, v] of Object.entries(entries)) fd.set(k, v);
    return fd;
  }

  it("rejects an empty/missing adId with INVALID_REQUEST", () => {
    const out = parseScoreForm(form({ adId: "  " }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("INVALID_REQUEST");
    const missing = parseScoreForm(form({}));
    expect(missing.ok).toBe(false);
  });

  it("clamps assumedSpendCents to bounds; absent/NaN → DEFAULT", () => {
    const lo = parseScoreForm(form({ adId: "a", assumedSpendCents: "0" }));
    const hi = parseScoreForm(form({ adId: "a", assumedSpendCents: "99999999" }));
    const absent = parseScoreForm(form({ adId: "a" }));
    if (!lo.ok || !hi.ok || !absent.ok) throw new Error("expected ok");
    expect(lo.assumedSpendCents).toBe(1000);
    expect(hi.assumedSpendCents).toBe(10_000_000);
    expect(absent.assumedSpendCents).toBe(DEFAULT_SPEND_CENTS);
  });

  it("coerces imageUrl '' / 'null' → null and missing creative fields → ''", () => {
    const empty = parseScoreForm(form({ adId: "a", imageUrl: "" }));
    const literal = parseScoreForm(form({ adId: "a", imageUrl: "null" }));
    const real = parseScoreForm(form({ adId: "a", imageUrl: "https://x.test/i.jpg" }));
    if (!empty.ok || !literal.ok || !real.ok) throw new Error("expected ok");
    expect(empty.creative.imageUrl).toBeNull();
    expect(literal.creative.imageUrl).toBeNull();
    expect(real.creative.imageUrl).toBe("https://x.test/i.jpg");
    // Missing text fields default to "".
    expect(empty.creative.headline).toBe("");
    expect(empty.creative.primaryText).toBe("");
    expect(empty.creative.cta).toBe("");
    expect(empty.creative.destinationUrl).toBe("");
    expect(empty.creative.audience).toBe("");
  });

  it("builds the creative from posted text fields", () => {
    const out = parseScoreForm(
      form({
        adId: "ad-1",
        headline: "H",
        primaryText: "P",
        cta: "SHOP_NOW",
        destinationUrl: "https://x.test/p",
        audience: "women 25-44",
      }),
    );
    if (!out.ok) throw new Error("expected ok");
    expect(out.adId).toBe("ad-1");
    expect(out.creative).toMatchObject({
      headline: "H",
      primaryText: "P",
      cta: "SHOP_NOW",
      destinationUrl: "https://x.test/p",
      audience: "women 25-44",
    });
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
