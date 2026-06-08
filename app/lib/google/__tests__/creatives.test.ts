// TDD coverage for the Google Ads creative parser + fetcher.
//
// parseGoogleAdCreative is PURE and defensive — it never throws on sparse/missing
// data (rule 12: surface gaps as empty defaults rather than crashing the detail
// page). Fixtures use the SAME snake_case key convention as the rest of the Google
// module (transform.ts reads `c.campaign?.id`, `r.metrics?.cost_micros`, …), since
// the searchStream rows are read snake_case throughout (rule 11).

import { describe, it, expect, vi } from "vitest";
import type { GoogleAdsClient } from "../client.server";
import {
  parseGoogleAdCreative,
  listGoogleCampaignCreatives,
} from "../creatives.server";

describe("parseGoogleAdCreative", () => {
  it("parses a responsive_search_ad row", () => {
    const out = parseGoogleAdCreative({
      ad_group_ad: {
        status: "ENABLED",
        ad: {
          id: "111",
          name: "RSA - Spring",
          final_urls: ["https://shop.example/spring", "https://shop.example/alt"],
          responsive_search_ad: {
            headlines: [{ text: "Spring Sale" }, { text: "Up to 40% off" }],
            descriptions: [{ text: "Free shipping over $50" }],
          },
        },
      },
    });

    expect(out.adId).toBe("111");
    expect(out.adName).toBe("RSA - Spring");
    expect(out.status).toBe("ENABLED");
    expect(out.creative.headline).toBe("Spring Sale");
    expect(out.creative.primaryText).toBe("Free shipping over $50");
    expect(out.creative.destinationUrl).toBe("https://shop.example/spring");
    expect(out.creative.cta).toBe("");
    expect(out.creative.imageUrl).toBeNull();
    expect(out.creative.audience).toBe("");
  });

  it("parses a responsive_display_ad row", () => {
    const out = parseGoogleAdCreative({
      ad_group_ad: {
        status: "PAUSED",
        ad: {
          id: "222",
          name: "RDA - Summer",
          final_urls: ["https://shop.example/summer"],
          responsive_display_ad: {
            headlines: [{ text: "Summer Drop" }],
            descriptions: [{ text: "New arrivals daily" }],
          },
        },
      },
    });

    expect(out.adId).toBe("222");
    expect(out.status).toBe("PAUSED");
    expect(out.creative.headline).toBe("Summer Drop");
    expect(out.creative.primaryText).toBe("New arrivals daily");
    expect(out.creative.destinationUrl).toBe("https://shop.example/summer");
    expect(out.creative.imageUrl).toBeNull();
  });

  it("parses a legacy expanded_text_ad row", () => {
    const out = parseGoogleAdCreative({
      ad_group_ad: {
        status: "ENABLED",
        ad: {
          id: "333",
          name: "ETA - Legacy",
          final_urls: ["https://shop.example/legacy"],
          expanded_text_ad: {
            headline_part1: "Legacy Headline",
            description: "Legacy description copy",
          },
        },
      },
    });

    expect(out.adId).toBe("333");
    expect(out.creative.headline).toBe("Legacy Headline");
    expect(out.creative.primaryText).toBe("Legacy description copy");
    expect(out.creative.destinationUrl).toBe("https://shop.example/legacy");
  });

  it("returns empty defaults on a sparse row without throwing", () => {
    const out = parseGoogleAdCreative({ ad_group_ad: { ad: {} } });
    expect(out.adId).toBe("");
    expect(out.adName).toBe("");
    expect(out.status).toBe("UNKNOWN");
    expect(out.creative).toEqual({
      imageUrl: null,
      headline: "",
      primaryText: "",
      cta: "",
      destinationUrl: "",
      audience: "",
    });
  });

  it("returns empty defaults on non-object input without throwing", () => {
    for (const input of [null, undefined, 42, "nope", []]) {
      const out = parseGoogleAdCreative(input);
      expect(out.adId).toBe("");
      expect(out.status).toBe("UNKNOWN");
      expect(out.creative.headline).toBe("");
      expect(out.creative.destinationUrl).toBe("");
      expect(out.creative.imageUrl).toBeNull();
    }
  });

  it("prefers the first ad subtype that yields a non-empty headline", () => {
    // RSA present but empty headline → fall through to display ad.
    const out = parseGoogleAdCreative({
      ad_group_ad: {
        ad: {
          id: "444",
          responsive_search_ad: { headlines: [], descriptions: [] },
          responsive_display_ad: {
            headlines: [{ text: "Display Wins" }],
            descriptions: [{ text: "from display" }],
          },
        },
      },
    });
    expect(out.creative.headline).toBe("Display Wins");
    expect(out.creative.primaryText).toBe("from display");
  });
});

describe("listGoogleCampaignCreatives", () => {
  it("maps each returned row via parseGoogleAdCreative", async () => {
    const search = vi.fn().mockResolvedValue([
      {
        ad_group_ad: {
          status: "ENABLED",
          ad: {
            id: "111",
            name: "Ad One",
            final_urls: ["https://shop.example/1"],
            responsive_search_ad: {
              headlines: [{ text: "One" }],
              descriptions: [{ text: "first" }],
            },
          },
        },
      },
      {
        ad_group_ad: {
          status: "PAUSED",
          ad: {
            id: "222",
            name: "Ad Two",
            final_urls: ["https://shop.example/2"],
            responsive_search_ad: {
              headlines: [{ text: "Two" }],
              descriptions: [{ text: "second" }],
            },
          },
        },
      },
    ]);
    const client: GoogleAdsClient = { search };

    const out = await listGoogleCampaignCreatives(client, "987654321");

    expect(out).toHaveLength(2);
    expect(out[0].adId).toBe("111");
    expect(out[1].adId).toBe("222");
    expect(out[0].creative.headline).toBe("One");

    const gaql = search.mock.calls[0][0] as string;
    expect(gaql).toContain("FROM ad_group_ad");
    expect(gaql).toContain("campaign.id = 987654321");
  });

  it("throws on a non-numeric campaignId and never calls search (injection guard)", async () => {
    const search = vi.fn();
    const client: GoogleAdsClient = { search };

    await expect(
      listGoogleCampaignCreatives(client, "1; DROP TABLE x"),
    ).rejects.toThrow("Invalid Google campaign id");
    expect(search).not.toHaveBeenCalled();
  });

  it("propagates an error thrown by the client (rule 12)", async () => {
    const search = vi.fn().mockRejectedValue(new Error("PERMISSION_DENIED"));
    const client: GoogleAdsClient = { search };

    await expect(
      listGoogleCampaignCreatives(client, "987654321"),
    ).rejects.toThrow("PERMISSION_DENIED");
  });
});
