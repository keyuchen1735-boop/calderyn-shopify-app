import { describe, it, expect, vi } from "vitest";
import { listCampaignAdSets } from "../creatives.server";
import type { MetaClient } from "../campaigns.server";
import { createPausedAd, deleteAd } from "../ad-create.server";
import type { CreativeInput } from "~/lib/screener/types";

function fakeClient(over: Partial<MetaClient> = {}): MetaClient {
  return {
    get: vi.fn(async () => ({ data: [] })),
    post: vi.fn(async () => ({ success: true })),
    ...over,
  };
}

const CREATIVE: CreativeInput = {
  imageUrl: "https://cdn.example.com/a.jpg",
  headline: "Summer Sale",
  primaryText: "50% off everything this week.",
  cta: "SHOP_NOW",
  destinationUrl: "https://shop.example.com/sale",
  audience: "",
};

describe("createPausedAd", () => {
  it("resolves a page, creates a creative, then a PAUSED ad, returning the new ad id", async () => {
    const get = vi.fn(async (path: string) =>
      path === "/act_1/promote_pages" ? { data: [{ id: "page_55" }] } : { data: [] },
    );
    const post = vi.fn(async (path: string, _body: Record<string, string>) => {
      if (path === "/act_1/adcreatives") return { id: "crea_9" };
      if (path === "/as1/ads") return { id: "ad_777" };
      return {};
    });

    const res = await createPausedAd(fakeClient({ get, post }), {
      adAccountId: "act_1",
      adSetId: "as1",
      creative: CREATIVE,
    });

    expect(get).toHaveBeenCalledWith("/act_1/promote_pages", { fields: "id" });
    // 1) creative carries the resolved page_id + link_data built from the variant
    expect(post).toHaveBeenNthCalledWith(
      1,
      "/act_1/adcreatives",
      expect.objectContaining({
        object_story_spec: expect.stringContaining('"page_id":"page_55"'),
      }),
    );
    expect((post.mock.calls[0][1] as Record<string, string>).object_story_spec).toContain(
      '"link":"https://shop.example.com/sale"',
    );
    // 2) ad references the creative, is PAUSED, and joins the supplied ad set
    expect(post).toHaveBeenNthCalledWith(
      2,
      "/as1/ads",
      expect.objectContaining({
        adset_id: "as1",
        status: "PAUSED",
        creative: expect.stringContaining('"creative_id":"crea_9"'),
      }),
    );
    expect(res).toEqual({ adId: "ad_777" });
  });

  it("fails loudly when the ad account has no usable Facebook Page", async () => {
    const get = vi.fn(async () => ({ data: [] }));
    await expect(
      createPausedAd(fakeClient({ get }), { adAccountId: "act_1", adSetId: "as1", creative: CREATIVE }),
    ).rejects.toThrow(/no Facebook Page/i);
  });

  it("throws on a permanent Graph error (permission denied) from the creative call", async () => {
    const get = vi.fn(async () => ({ data: [{ id: "page_55" }] }));
    const post = vi.fn(async () => ({ error: { message: "Permission denied", code: 200 } }));
    await expect(
      createPausedAd(fakeClient({ get, post }), { adAccountId: "act_1", adSetId: "as1", creative: CREATIVE }),
    ).rejects.toThrow(/Permission denied/);
  });
});

describe("deleteAd", () => {
  it("deletes an ad by setting the writable status to DELETED", async () => {
    const post = vi.fn(async () => ({ success: true }));
    await deleteAd(fakeClient({ post }), "ad_777");
    expect(post).toHaveBeenCalledWith("/ad_777", { status: "DELETED" });
  });

  it("throws on a Graph error payload", async () => {
    const post = vi.fn(async () => ({ error: { message: "Unknown id", code: 100 } }));
    await expect(deleteAd(fakeClient({ post }), "ad_777")).rejects.toThrow(/Unknown id/);
  });
});

describe("listCampaignAdSets", () => {
  it("requests the campaign's ad sets and maps id/name/status", async () => {
    const get = vi.fn(async () => ({
      data: [
        { id: "as1", name: "Prospecting", status: "ACTIVE" },
        { id: "as2", name: "Retarget", status: "PAUSED" },
      ],
    }));
    const rows = await listCampaignAdSets(fakeClient({ get }), "120");
    expect(get).toHaveBeenCalledWith("/120/adsets", { fields: "id,name,status" });
    expect(rows).toEqual([
      { id: "as1", name: "Prospecting", status: "ACTIVE" },
      { id: "as2", name: "Retarget", status: "PAUSED" },
    ]);
  });

  it("rejects a non-numeric campaign id (injection guard)", async () => {
    await expect(listCampaignAdSets(fakeClient(), "../evil")).rejects.toThrow(/Invalid Meta campaign id/);
  });

  it("throws on a Graph error payload", async () => {
    const get = vi.fn(async () => ({ error: { message: "Unknown id", code: 100 } }));
    await expect(listCampaignAdSets(fakeClient({ get }), "120")).rejects.toThrow(/Unknown id/);
  });
});
