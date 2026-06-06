import { describe, it, expect, vi, beforeEach } from "vitest";

const { adaptersForShops, backfillAds, pollAdsDaily, updateSync } = vi.hoisted(() => ({
  adaptersForShops: vi.fn(),
  backfillAds: vi.fn(async () => {}),
  pollAdsDaily: vi.fn(async () => {}),
  updateSync: vi.fn(async () => {}),
}));

vi.mock("~/lib/ads/registry.server", () => ({ adaptersForShops }));
vi.mock("~/lib/ads/ingest.server", () => ({ backfillAds, pollAdsDaily }));
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: () => ({ update: () => ({ eq: () => ({ eq: () => { updateSync(); return Promise.resolve({ error: null }); } }) }) }),
  }),
}));

import { loader } from "../cron.ingest-ads";

function req(auth?: string): Request {
  const headers = new Headers();
  if (auth) headers.set("authorization", auth);
  return new Request("http://x/cron/ingest-ads", { headers });
}

describe("cron.ingest-ads loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "s3cret";
  });

  it("rejects an unauthorized request", async () => {
    const res = await loader({ request: req("Bearer wrong") } as never);
    expect(res.status).toBe(401);
  });

  it("backfills pending and polls live, isolating failures", async () => {
    const source = { fetchCampaigns: vi.fn(), fetchBackfillSpend: vi.fn(), fetchDailySpend: vi.fn() };
    adaptersForShops.mockResolvedValue([
      { shopId: "s1", status: "pending", adapter: { platform: "meta", integrationKind: "meta_ads", connect: async () => source } },
      { shopId: "s2", status: "live", adapter: { platform: "tiktok", integrationKind: "tiktok_ads", connect: async () => source } },
      { shopId: "s3", status: "live", adapter: { platform: "google", integrationKind: "google_ads", connect: async () => { throw new Error("boom"); } } },
    ]);
    const res = await loader({ request: req("Bearer s3cret") } as never);
    const body = await res.json();
    expect(backfillAds).toHaveBeenCalledTimes(1);
    expect(pollAdsDaily).toHaveBeenCalledTimes(1);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]).toContain("s3");
  });

  it("skips shops with no connection", async () => {
    adaptersForShops.mockResolvedValue([
      { shopId: "s4", status: "live", adapter: { platform: "meta", integrationKind: "meta_ads", connect: async () => null } },
    ]);
    const res = await loader({ request: req("Bearer s3cret") } as never);
    const body = await res.json();
    expect(body.skipped).toContain("s4:meta");
    expect(pollAdsDaily).not.toHaveBeenCalled();
  });
});
