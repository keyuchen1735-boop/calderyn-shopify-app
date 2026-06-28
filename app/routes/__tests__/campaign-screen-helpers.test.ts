import { describe, it, expect, vi } from "vitest";

vi.mock("../../shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "acme.myshopify.com" } }) },
}));

/* eslint-disable import/first -- imports must follow vi.mock */
import { parseCampaignScreenForm } from "../app.campaigns.$campaignId.screen";
import { parseScreenBody } from "../dashboard.api.campaigns.$id.screen";
import { DEFAULT_SPEND_CENTS, MIN_SPEND_CENTS } from "~/lib/screener/types";
/* eslint-enable import/first */

describe("parseCampaignScreenForm (embedded, FormData)", () => {
  function fd(entries: Record<string, string>): FormData {
    const f = new FormData();
    for (const [k, v] of Object.entries(entries)) f.set(k, v);
    return f;
  }
  it("builds a CreativeInput, defaults cta to SHOP_NOW, defaults spend", () => {
    const { input, assumedSpendCents } = parseCampaignScreenForm(
      fd({ headline: "H", primaryText: "P", destinationUrl: "https://x.test/p", audience: "a", mediaKind: "image", imageUrl: "data:image/png;base64,AAAA" }),
    );
    expect(input.cta).toBe("SHOP_NOW");
    expect(input.mediaKind).toBe("image");
    expect(input.imageUrl).toBe("data:image/png;base64,AAAA");
    expect(assumedSpendCents).toBe(DEFAULT_SPEND_CENTS);
  });
  it("parses video frame urls JSON and clamps spend", () => {
    const { input, assumedSpendCents } = parseCampaignScreenForm(
      fd({ mediaKind: "video", videoFrameUrls: JSON.stringify(["data:image/png;base64,A"]), videoDurationSec: "8", assumedSpendCents: "1" }),
    );
    expect(input.videoFrameUrls).toEqual(["data:image/png;base64,A"]);
    expect(input.videoDurationSec).toBe(8);
    expect(assumedSpendCents).toBe(MIN_SPEND_CENTS);
  });
  it("falls back to no frames on malformed JSON", () => {
    const { input } = parseCampaignScreenForm(fd({ mediaKind: "video", videoFrameUrls: "{bad" }));
    expect(input.videoFrameUrls).toEqual([]);
  });
});

describe("parseScreenBody (dashboard, JSON)", () => {
  it("delegates to creativeInputFromJson and clamps spend", () => {
    const { input, assumedSpendCents } = parseScreenBody({ headline: "H", mediaKind: "image", imageUrl: "data:image/png;base64,A", assumedSpendCents: 1 });
    expect(input.headline).toBe("H");
    expect(input.cta).toBe("SHOP_NOW");
    expect(assumedSpendCents).toBe(MIN_SPEND_CENTS);
  });
  it("defaults spend when absent", () => {
    expect(parseScreenBody({}).assumedSpendCents).toBe(DEFAULT_SPEND_CENTS);
  });
});
