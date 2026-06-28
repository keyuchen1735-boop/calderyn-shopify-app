import { describe, it, expect, vi } from "vitest";

// The score resource route eagerly constructs the Shopify app at import
// (shopify.server calls shopifyApp({ appUrl }) at module load), which throws
// "empty appUrl" when SHOPIFY_APP_URL is unset — e.g. in CI. parseScoreForm
// doesn't touch authenticate, so stub shopify.server like the other route tests do.
vi.mock("../../../shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "acme.myshopify.com" } }) },
}));

/* eslint-disable import/first -- imports must follow vi.mock so the shopify.server stub is registered before the route module loads */
import { parseScoreForm } from "../../../routes/app.campaigns.$campaignId.score";
import { DEFAULT_SPEND_CENTS } from "../types";
import { pickGenerator } from "../pick-generator.server";
/* eslint-enable import/first */

describe("pickGenerator", () => {
  const deps = { createMessage: vi.fn(), model: "m" };
  it("returns the image generator for mode 'image'", () => {
    expect(pickGenerator("image", deps).mode).toBe("image");
  });
  it("defaults to the copy generator for copy / null / unknown modes", () => {
    expect(pickGenerator("copy", deps).mode).toBe("copy");
    expect(pickGenerator(null, deps).mode).toBe("copy");
    expect(pickGenerator("bogus", deps).mode).toBe("copy");
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
