import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  discoverShopCompetitors: vi.fn(),
}));
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ rpc: mocks.rpcMock }) }));
vi.mock("~/lib/radar/discovery.server", () => ({ discoverShopCompetitors: mocks.discoverShopCompetitors }));

// eslint-disable-next-line import/first -- hoisted mocks must be defined before imports
import { loader } from "../cron.radar-discover";

function req(auth?: string): never {
  return {
    request: new Request("https://x/cron/radar-discover", { headers: auth ? { authorization: auth } : {} }),
    params: {},
    context: {},
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = "sekrit";
  mocks.rpcMock.mockResolvedValue({ data: [{ shop_id: "s1" }, { shop_id: "s2" }, { shop_id: "s3" }], error: null });
});

describe("cron.radar-discover", () => {
  it("401s without the bearer secret", async () => {
    const res = await loader(req());
    expect(res.status).toBe(401);
    expect(mocks.rpcMock).not.toHaveBeenCalled();
  });
  it("drains the discovery queue with per-shop isolation and totals", async () => {
    mocks.discoverShopCompetitors
      .mockResolvedValueOnce({ suggested: 2 })
      .mockResolvedValueOnce({ skipped: "demo_shop" })
      .mockRejectedValueOnce(new Error("anthropic down"));
    const res = await loader(req("Bearer sekrit"));
    expect(mocks.rpcMock).toHaveBeenCalledWith("radar_discovery_queue", { p_limit: 200 });
    const body = await res.json();
    expect(body).toMatchObject({ suggested: 2, skippedShops: 1, failed: 1, budgetStopped: false });
    expect(mocks.discoverShopCompetitors).toHaveBeenCalledTimes(3);
  });
  it("500s with the queue error surfaced", async () => {
    mocks.rpcMock.mockResolvedValueOnce({ data: null, error: { message: "queue broke" } });
    const res = await loader(req("Bearer sekrit"));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("queue broke");
  });
});
