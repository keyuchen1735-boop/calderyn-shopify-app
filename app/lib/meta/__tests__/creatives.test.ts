import { describe, it, expect, vi } from "vitest";
import { parseAdCreative, listCampaignCreatives, CREATIVE_FIELDS } from "../creatives.server";
import type { MetaClient } from "../campaigns.server";

function fakeClient(over: Partial<MetaClient> = {}): MetaClient {
  return {
    get: vi.fn(async () => ({ data: [] })),
    post: vi.fn(async () => ({ success: true })),
    ...over,
  };
}

describe("parseAdCreative", () => {
  it("parses an object_story_spec.link_data ad (all 5 fields)", () => {
    const raw = {
      id: "ad_1",
      name: "Summer Promo",
      status: "ACTIVE",
      creative: {
        object_story_spec: {
          link_data: {
            message: "Get 20% off everything.",
            name: "Summer Sale",
            link: "https://shop.example/summer",
            picture: "https://cdn.example/summer.jpg",
            call_to_action: { type: "SHOP_NOW" },
          },
        },
      },
    };
    expect(parseAdCreative(raw)).toEqual({
      adId: "ad_1",
      adName: "Summer Promo",
      status: "ACTIVE",
      creative: {
        imageUrl: "https://cdn.example/summer.jpg",
        headline: "Summer Sale",
        primaryText: "Get 20% off everything.",
        cta: "SHOP_NOW",
        destinationUrl: "https://shop.example/summer",
        audience: "",
      },
    });
  });

  it("parses a legacy top-level creative ad", () => {
    const raw = {
      id: "ad_2",
      name: "Legacy Ad",
      status: "PAUSED",
      creative: {
        title: "Legacy Headline",
        body: "Legacy body copy.",
        image_url: "https://cdn.example/legacy.jpg",
        object_url: "https://shop.example/legacy",
        call_to_action_type: "LEARN_MORE",
      },
    };
    expect(parseAdCreative(raw)).toEqual({
      adId: "ad_2",
      adName: "Legacy Ad",
      status: "PAUSED",
      creative: {
        imageUrl: "https://cdn.example/legacy.jpg",
        headline: "Legacy Headline",
        primaryText: "Legacy body copy.",
        cta: "LEARN_MORE",
        destinationUrl: "https://shop.example/legacy",
        audience: "",
      },
    });
  });

  it("falls back to link_url when object_url is absent in legacy creative", () => {
    const raw = {
      id: "ad_2b",
      name: "Legacy Link",
      status: "ACTIVE",
      creative: {
        title: "T",
        body: "B",
        link_url: "https://shop.example/via-link-url",
      },
    };
    expect(parseAdCreative(raw).creative.destinationUrl).toBe(
      "https://shop.example/via-link-url",
    );
  });

  it("parses an asset_feed_spec (Advantage+) ad, taking first array elements", () => {
    const raw = {
      id: "ad_3",
      name: "Advantage+ Ad",
      status: "ACTIVE",
      creative: {
        asset_feed_spec: {
          titles: [{ text: "First Title" }, { text: "Second Title" }],
          bodies: [{ text: "First Body" }, { text: "Second Body" }],
          call_to_action_types: ["BUY_NOW", "SHOP_NOW"],
          link_urls: [
            { website_url: "https://shop.example/first" },
            { website_url: "https://shop.example/second" },
          ],
          images: [{ url: "https://cdn.example/first.jpg" }],
        },
      },
    };
    expect(parseAdCreative(raw)).toEqual({
      adId: "ad_3",
      adName: "Advantage+ Ad",
      status: "ACTIVE",
      creative: {
        imageUrl: "https://cdn.example/first.jpg",
        headline: "First Title",
        primaryText: "First Body",
        cta: "BUY_NOW",
        destinationUrl: "https://shop.example/first",
        audience: "",
      },
    });
  });

  it("degrades a missing imageUrl in asset_feed_spec to null", () => {
    const raw = {
      id: "ad_3b",
      name: "No Image",
      status: "ACTIVE",
      creative: {
        asset_feed_spec: {
          titles: [{ text: "T" }],
          bodies: [{ text: "B" }],
        },
      },
    };
    expect(parseAdCreative(raw).creative.imageUrl).toBeNull();
  });

  it("returns sensible defaults for an empty/sparse ad without throwing", () => {
    expect(parseAdCreative({})).toEqual({
      adId: "",
      adName: "",
      status: "UNKNOWN",
      creative: {
        imageUrl: null,
        headline: "",
        primaryText: "",
        cta: "",
        destinationUrl: "",
        audience: "",
      },
    });
  });

  it("does not throw on entirely non-object input", () => {
    expect(() => parseAdCreative(null)).not.toThrow();
    expect(() => parseAdCreative(undefined)).not.toThrow();
    expect(() => parseAdCreative("nope")).not.toThrow();
    expect(parseAdCreative(null).status).toBe("UNKNOWN");
  });
});

describe("listCampaignCreatives", () => {
  it("requests the campaign ads with creative fields and maps each ad", async () => {
    const get = vi.fn(async () => ({
      data: [
        {
          id: "ad_1",
          name: "One",
          status: "ACTIVE",
          creative: {
            object_story_spec: {
              link_data: {
                message: "M1",
                name: "H1",
                link: "https://a.example/1",
                picture: "https://cdn.example/1.jpg",
                call_to_action: { type: "SHOP_NOW" },
              },
            },
          },
        },
        {
          id: "ad_2",
          name: "Two",
          status: "PAUSED",
          creative: {
            title: "H2",
            body: "M2",
            image_url: "https://cdn.example/2.jpg",
            object_url: "https://a.example/2",
            call_to_action_type: "LEARN_MORE",
          },
        },
      ],
    }));
    const rows = await listCampaignCreatives(fakeClient({ get }), "camp_99");
    expect(get).toHaveBeenCalledWith("/camp_99/ads", {
      fields: CREATIVE_FIELDS,
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].adId).toBe("ad_1");
    expect(rows[0].creative.headline).toBe("H1");
    expect(rows[1].adId).toBe("ad_2");
    expect(rows[1].creative.cta).toBe("LEARN_MORE");
  });

  it("throws on a Graph error payload", async () => {
    const client = fakeClient({
      get: vi.fn(async () => ({ error: { message: "Invalid token", code: 190 } })),
    });
    await expect(listCampaignCreatives(client, "camp_99")).rejects.toThrow(/Invalid token/);
  });

  it("returns an empty array when data is absent", async () => {
    const rows = await listCampaignCreatives(fakeClient({ get: vi.fn(async () => ({})) }), "c");
    expect(rows).toEqual([]);
  });
});
