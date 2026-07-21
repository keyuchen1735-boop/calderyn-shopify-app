import { describe, expect, it, vi } from "vitest";

import { fetchSearchAnalytics, pickSiteForOrigin, upsertRankings, pullShopRankings } from "../search-console.server";
import { loadGscRefreshToken } from "../gsc.server";

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }));
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ from: fromMock }) }));
vi.mock("../gsc.server", () => ({
  loadGscRefreshToken: vi.fn().mockResolvedValue("rt"),
  refreshGscAccessToken: vi.fn().mockResolvedValue("at"),
}));

describe("pickSiteForOrigin", () => {
  it("prefers exact url-prefix property, then sc-domain", () => {
    const sites = ["sc-domain:calderyncompany.com", "https://peak.calderyncompany.com/"];
    expect(pickSiteForOrigin(sites, "https://peak.calderyncompany.com")).toBe("https://peak.calderyncompany.com/");
    expect(pickSiteForOrigin(["sc-domain:calderyncompany.com"], "https://peak.calderyncompany.com")).toBe("sc-domain:calderyncompany.com");
    expect(pickSiteForOrigin(["https://other.com/"], "https://peak.calderyncompany.com")).toBeNull();
  });

  it("rejects suffix false-positive for sc-domain", () => {
    // "shop-abc.com" endsWith("abc.com") is true, but should NOT match sc-domain:abc.com
    expect(pickSiteForOrigin(["sc-domain:abc.com"], "https://shop-abc.com")).toBeNull();
  });

  it("matches subdomain correctly with sc-domain", () => {
    expect(pickSiteForOrigin(["sc-domain:abc.com"], "https://www.abc.com")).toBe("sc-domain:abc.com");
  });
});

describe("fetchSearchAnalytics", () => {
  it("maps rows and throws with the Google body on error", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      rows: [{ keys: ["trail boots", "https://x/p/boots"], position: 4.2, impressions: 100, clicks: 9, ctr: 0.09 }],
    }), { status: 200 }));
    const rows = await fetchSearchAnalytics("at", "sc-domain:x.com", "2026-07-18", fetcher as typeof fetch);
    expect(rows).toEqual([{ query: "trail boots", pageUrl: "https://x/p/boots", position: 4.2, impressions: 100, clicks: 9, ctr: 0.09 }]);
    const url = (fetcher.mock.calls[0] as unknown[])[0] as string;
    expect(url).toContain(encodeURIComponent("sc-domain:x.com"));
    const failing = vi.fn().mockResolvedValue(new Response('{"error":"forbidden"}', { status: 403 }));
    await expect(fetchSearchAnalytics("at", "s", "2026-07-18", failing as typeof fetch)).rejects.toThrow(/403/);
  });
});

describe("upsertRankings", () => {
  it("upserts on the natural key and returns the row count", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    fromMock.mockReturnValue({ upsert });
    const n = await upsertRankings("shop-1", "2026-07-18", [
      { query: "q", pageUrl: "u", position: 5, impressions: 10, clicks: 1, ctr: 0.1 },
    ]);
    expect(n).toBe(1);
    expect(upsert).toHaveBeenCalledWith(
      [expect.objectContaining({ shop_id: "shop-1", query: "q", page_url: "u", captured_date: "2026-07-18" })],
      { onConflict: "shop_id,query,page_url,captured_date" },
    );
  });
});

describe("pullShopRankings", () => {
  it("pulls the three lagged days idempotently and stamps the cursor", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const maybeSingle = vi.fn().mockResolvedValue({ data: { gsc_site_url: "sc-domain:x.com" }, error: null });
    const stampUpdate = vi.fn().mockResolvedValue({ error: null });
    fromMock.mockImplementation((table: string) =>
      table === "seo_settings"
        ? { select: () => ({ eq: () => ({ maybeSingle }) }), update: () => ({ eq: stampUpdate }) }
        : { upsert });
    const fetcher = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ rows: [] }), { status: 200 })),
    );
    const out = await pullShopRankings("shop-1", { fetcher: fetcher as typeof fetch, today: new Date("2026-07-20T12:00:00Z") });
    expect(out.days).toBe(3);
    expect(fetcher).toHaveBeenCalledTimes(3); // 2026-07-18, 17, 16
    expect(stampUpdate).toHaveBeenCalledWith("shop_id", "shop-1");
  });

  it("rejects when gsc_refresh_token is not connected", async () => {
    vi.mocked(loadGscRefreshToken).mockResolvedValueOnce(null);
    await expect(pullShopRankings("shop-1")).rejects.toThrow(/gsc_not_connected/);
  });

  it("rejects when seo_settings has no gsc_site_url", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: { gsc_site_url: null }, error: null });
    fromMock.mockImplementation((table: string) =>
      table === "seo_settings"
        ? { select: () => ({ eq: () => ({ maybeSingle }) }) }
        : { upsert: vi.fn() });
    await expect(pullShopRankings("shop-1")).rejects.toThrow(/gsc_site_not_set/);
  });
});
