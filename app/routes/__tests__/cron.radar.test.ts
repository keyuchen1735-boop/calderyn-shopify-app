import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  collectShop: vi.fn(),
  draftShopMoves: vi.fn(),
}));
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ rpc: mocks.rpcMock }) }));
vi.mock("~/lib/radar/collect.server", () => ({ collectShop: mocks.collectShop }));
vi.mock("~/lib/radar/draft.server", () => ({ draftShopMoves: mocks.draftShopMoves }));

// eslint-disable-next-line import/first -- hoisted mocks must be defined before imports
import { loader as collectLoader } from "../cron.radar-collect";
// eslint-disable-next-line import/first -- hoisted mocks must be defined before imports
import { loader as draftLoader } from "../cron.radar-draft";

function req(path: string, auth?: string): never {
  return {
    request: new Request(`https://x${path}`, { headers: auth ? { authorization: auth } : {} }),
    params: {},
    context: {},
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = "sekrit";
  mocks.rpcMock.mockResolvedValue({ data: [{ shop_id: "s1" }, { shop_id: "s2" }], error: null });
});

describe("cron.radar-collect", () => {
  it("401s without the bearer secret", async () => {
    const res = await collectLoader(req("/cron/radar-collect"));
    expect(res.status).toBe(401);
    expect(mocks.rpcMock).not.toHaveBeenCalled();
  });
  it("drains the collect queue with per-shop isolation", async () => {
    mocks.collectShop.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("shop down"));
    const res = await collectLoader(req("/cron/radar-collect", "Bearer sekrit"));
    expect(mocks.rpcMock).toHaveBeenCalledWith("radar_shop_queue", { p_for: "collect", p_limit: 500 });
    const body = await res.json();
    expect(body).toMatchObject({ collected: 1, failed: 1, skipped: false });
    expect(mocks.collectShop).toHaveBeenCalledTimes(2);
  });
  it("500s with the queue error surfaced", async () => {
    mocks.rpcMock.mockResolvedValueOnce({ data: null, error: { message: "queue broke" } });
    const res = await collectLoader(req("/cron/radar-collect", "Bearer sekrit"));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("queue broke");
  });
});

describe("cron.radar-draft", () => {
  it("drains the draft queue and totals the summaries", async () => {
    mocks.draftShopMoves
      .mockResolvedValueOnce({ expired: 1, drafted: 2, polished: 1, skipped: 0 })
      .mockRejectedValueOnce(new Error("nope"));
    const res = await draftLoader(req("/cron/radar-draft", "Bearer sekrit"));
    expect(mocks.rpcMock).toHaveBeenCalledWith("radar_shop_queue", { p_for: "draft", p_limit: 500 });
    const body = await res.json();
    expect(body).toMatchObject({ drafted: 2, failed: 1, skipped: false });
  });
  it("401s without the bearer secret", async () => {
    const res = await draftLoader(req("/cron/radar-draft"));
    expect(res.status).toBe(401);
  });
});
