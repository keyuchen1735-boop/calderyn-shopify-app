import { describe, expect, it, vi, afterEach } from "vitest";

import { loader } from "../cron.seo-rankings";

const mocks = vi.hoisted(() => ({
  pullShopRankings: vi.fn(),
  rows: [{ shop_id: "s1" }, { shop_id: "s2" }],
  settingsResult: { data: null as any, error: null as any },
  orderArgs: [] as unknown[],
  notArgs: [] as unknown[],
  stampedShops: [] as unknown[],
}));
vi.mock("~/lib/seo/search-console.server", () => ({ pullShopRankings: mocks.pullShopRankings }));
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          // Plain closures (not vi.fn) so vi.restoreAllMocks() in afterEach
          // can't wipe the recorded args or the settingsResult passthrough.
          not: (...notArgs: unknown[]) => {
            mocks.notArgs = notArgs;
            return {
              order: (...args: unknown[]) => {
                mocks.orderArgs = args;
                return Promise.resolve({ data: mocks.settingsResult.data, error: mocks.settingsResult.error });
              },
            };
          },
        }),
      }),
      update: () => ({
        eq: (_col: unknown, shopId: unknown) => {
          mocks.stampedShops.push(shopId);
          return Promise.resolve({ error: null });
        },
      }),
    }),
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
    mocks.stampedShops = [];
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
    expect(mocks.orderArgs).toEqual(["gsc_last_pulled_at", { ascending: true, nullsFirst: true }]);
    expect(mocks.notArgs).toEqual(["gsc_site_url", "is", null]);
    // Attempt time is stamped for BOTH shops — including the failing one — so
    // permanently-failing shops rotate to the back of the nullsFirst queue.
    expect(mocks.stampedShops).toEqual(["s1", "s2"]);
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
    expect(body).toMatchObject({ pulled: 0, failed: 0, skipped: true });
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
