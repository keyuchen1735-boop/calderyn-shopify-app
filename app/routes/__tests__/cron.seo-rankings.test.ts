import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pullShopRankings: vi.fn(),
  rows: [{ shop_id: "s1" }, { shop_id: "s2" }],
}));
vi.mock("~/lib/seo/search-console.server", () => ({ pullShopRankings: mocks.pullShopRankings }));
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: () => ({ select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: mocks.rows, error: null }) }) }) }),
  }),
}));

import { loader } from "../cron.seo-rankings";

function req(auth?: string): never {
  return {
    request: new Request("https://x/cron/seo-rankings", { headers: auth ? { authorization: auth } : {} }),
    params: {}, context: {},
  } as never;
}

describe("cron.seo-rankings", () => {
  it("401s without the bearer secret", async () => {
    process.env.CRON_SECRET = "sekrit";
    const res = await loader(req());
    expect(res.status).toBe(401);
  });
  it("drains connected shops with per-shop isolation", async () => {
    process.env.CRON_SECRET = "sekrit";
    mocks.pullShopRankings
      .mockResolvedValueOnce({ days: 3, rows: 10 })
      .mockRejectedValueOnce(new Error("gsc_site_not_set"));
    const res = await loader(req("Bearer sekrit"));
    const body = await res.json();
    expect(body).toMatchObject({ pulled: 1, failed: 1 });
    expect(mocks.pullShopRankings).toHaveBeenCalledTimes(2);
  });
});
