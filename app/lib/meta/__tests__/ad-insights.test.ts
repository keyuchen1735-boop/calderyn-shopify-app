import { describe, it, expect, vi } from "vitest";
import { parseAdInsightRow, listCampaignAdInsights } from "../ad-insights.server";
import type { MetaClient } from "../campaigns.server";

function fakeClient(over: Partial<MetaClient> = {}): MetaClient {
  return {
    get: vi.fn(async () => ({ data: [] })),
    post: vi.fn(async () => ({ success: true })),
    ...over,
  };
}

describe("parseAdInsightRow", () => {
  it("parses a full row (all fields present) to cents/int/percent", () => {
    const raw = {
      ad_id: "ad_1",
      spend: "12.34",
      impressions: "1000",
      clicks: "25",
      ctr: "2.5",
      cpm: "8.76",
    };
    expect(parseAdInsightRow(raw)).toEqual({
      adId: "ad_1",
      spendCents: 1234,
      impressions: 1000,
      clicks: 25,
      ctr: 2.5,
      cpmCents: 876,
    });
  });

  it("returns null (NOT 0) for missing spend/cpm/clicks, parses the rest", () => {
    const raw = {
      ad_id: "ad_2",
      impressions: "500",
      ctr: "1.1",
      // spend, cpm, clicks absent
    };
    expect(parseAdInsightRow(raw)).toEqual({
      adId: "ad_2",
      spendCents: null,
      impressions: 500,
      clicks: null,
      ctr: 1.1,
      cpmCents: null,
    });
  });

  it("treats blank-string and non-finite money fields as null, not 0", () => {
    const raw = { ad_id: "ad_3", spend: "", cpm: "not-a-number", clicks: "" };
    const m = parseAdInsightRow(raw);
    expect(m.spendCents).toBeNull();
    expect(m.cpmCents).toBeNull();
    expect(m.clicks).toBeNull();
  });

  it("returns an all-null AdMetrics with adId '' for non-object input", () => {
    for (const bad of [null, undefined, "nope", 42] as const) {
      expect(parseAdInsightRow(bad)).toEqual({
        adId: "",
        spendCents: null,
        impressions: null,
        clicks: null,
        ctr: null,
        cpmCents: null,
      });
    }
  });

  it("returns an all-null AdMetrics with adId '' for empty object", () => {
    expect(parseAdInsightRow({})).toEqual({
      adId: "",
      spendCents: null,
      impressions: null,
      clicks: null,
      ctr: null,
      cpmCents: null,
    });
  });
});

describe("listCampaignAdInsights", () => {
  it("requests ad-level insights with the right path/params and maps a 2-ad response", async () => {
    const get = vi.fn(async () => ({
      data: [
        { ad_id: "ad_1", spend: "10.00", impressions: "2000", clicks: "40", ctr: "2.0", cpm: "5.00" },
        { ad_id: "ad_2", spend: "3.50", impressions: "100", clicks: "1", ctr: "1.0", cpm: "35.00" },
      ],
    }));
    const rows = await listCampaignAdInsights(fakeClient({ get }), "camp_1");
    expect(get).toHaveBeenCalledWith("/camp_1/insights", {
      level: "ad",
      date_preset: "last_7d",
      fields: "ad_id,impressions,clicks,spend,ctr,cpm",
      limit: "500",
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      adId: "ad_1",
      spendCents: 1000,
      impressions: 2000,
      clicks: 40,
      ctr: 2.0,
      cpmCents: 500,
    });
    expect(rows[1].adId).toBe("ad_2");
    expect(rows[1].cpmCents).toBe(3500);
  });

  it("throws on a Meta error payload", async () => {
    const client = fakeClient({
      get: vi.fn(async () => ({ error: { message: "Invalid token", code: 190 } })),
    });
    await expect(listCampaignAdInsights(client, "camp_1")).rejects.toThrow(/Invalid token/);
  });

  it("pages through paging.next + cursors.after and returns both pages' ads", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({
        data: [{ ad_id: "ad_1", spend: "1.00", impressions: "10", clicks: "1", ctr: "1.0", cpm: "1.00" }],
        paging: { next: "https://graph/next", cursors: { after: "CURSOR_1" } },
      })
      .mockResolvedValueOnce({
        data: [{ ad_id: "ad_2", spend: "2.00", impressions: "20", clicks: "2", ctr: "2.0", cpm: "2.00" }],
      });
    const rows = await listCampaignAdInsights(fakeClient({ get }), "camp_1");
    expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenNthCalledWith(2, "/camp_1/insights", expect.objectContaining({ after: "CURSOR_1" }));
    expect(rows.map((r) => r.adId)).toEqual(["ad_1", "ad_2"]);
  });
});
