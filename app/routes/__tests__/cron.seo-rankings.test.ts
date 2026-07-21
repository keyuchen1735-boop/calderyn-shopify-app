import { describe, expect, it, vi, afterEach } from "vitest";

import { loader } from "../cron.seo-rankings";

const mocks = vi.hoisted(() => ({
  pullShopRankings: vi.fn(),
  rows: [{ shop_id: "s1" }, { shop_id: "s2" }],
  settingsResult: { data: null as any, error: null as any },
}));
vi.mock("~/lib/seo/search-console.server", () => ({ pullShopRankings: mocks.pullShopRankings }));
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: () => ({ select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: mocks.settingsResult.data, error: mocks.settingsResult.error }) }) }) }),
  }),
}));

function req(auth?: string): never {
  return {
    request: new Request("https://x/cron/seo-rankings", { headers: auth ? { authorization: auth } : {} }),
    params: {}, context: {},
  } as never;
}

describe("cron.seo-rankings", () => {
  afterEach(() => {
    mocks.settingsResult = { data: mocks.rows, error: null };
    vi.restoreAllMocks();
  });

  it("401s without the bearer secret", async () => {
    process.env.CRON_SECRET = "sekrit";
    mocks.settingsResult = { data: mocks.rows, error: null };
    const res = await loader(req());
    expect(res.status).toBe(401);
  });
  it("drains connected shops with per-shop isolation", async () => {
    process.env.CRON_SECRET = "sekrit";
    mocks.settingsResult = { data: mocks.rows, error: null };
    mocks.pullShopRankings
      .mockResolvedValueOnce({ days: 3, rows: 10 })
      .mockRejectedValueOnce(new Error("gsc_site_not_set"));
    const res = await loader(req("Bearer sekrit"));
    const body = await res.json();
    expect(body).toMatchObject({ pulled: 1, failed: 1 });
    expect(mocks.pullShopRankings).toHaveBeenCalledTimes(2);
  });

  it("skips shops when time budget exceeded", async () => {
    process.env.CRON_SECRET = "sekrit";
    mocks.settingsResult = { data: mocks.rows, error: null };
    mocks.pullShopRankings.mockClear();
    const baseTime = 1000;
    let callCount = 0;
    vi.spyOn(Date, "now").mockImplementation(() => {
      if (callCount === 0) {
        callCount++;
        return baseTime;
      }
      return baseTime + 60_000;
    });
    const res = await loader(req("Bearer sekrit"));
    const body = await res.json();
    expect(body.skipped).toBe(true);
    expect(mocks.pullShopRankings).not.toHaveBeenCalled();
  });

  it("returns 500 when settings query fails", async () => {
    process.env.CRON_SECRET = "sekrit";
    mocks.settingsResult = { data: null, error: { message: "boom" } };
    const res = await loader(req("Bearer sekrit"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("boom");
  });
});
