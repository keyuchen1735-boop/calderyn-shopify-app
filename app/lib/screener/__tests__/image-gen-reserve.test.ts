import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildChain,
  setSupabaseResponses,
  getRecorded,
} from "../../__tests__/_supabase_chain_mock";
import {
  checkAndReserveImageGen,
  releaseImageGen,
  reserveImageGenSlots,
} from "../image-gen-limit.server";

vi.mock("../../supabase.server", () => ({
  getSupabase: () => buildChain(),
  resolveShopId: vi.fn(async (domain: string) => `shop-id-for-${domain}`),
}));

const SHOP = "demo.myshopify.com";
const NOW = new Date("2026-06-10T12:00:00.000Z"); // UTC day = 2026-06-10
const count = (n: number) => ({ data: null, count: n, error: null });

beforeEach(() => {
  delete process.env.IMAGE_GEN_DAILY_PER_SHOP;
  delete process.env.IMAGE_GEN_DAILY_GLOBAL;
});

describe("checkAndReserveImageGen", () => {
  it("reserves a slot, reports remaining, and returns the event id for release", async () => {
    setSupabaseResponses([count(5), count(100), { data: { id: "evt-1" }, error: null }]);
    const res = await checkAndReserveImageGen(SHOP, NOW);
    expect(res).toEqual({ ok: true, remaining: 14, eventId: "evt-1" }); // 20 - 5 - 1

    const inserts = getRecorded("insert");
    expect(inserts).toHaveLength(1);
    expect(inserts[0][0]).toMatchObject({
      shop_id: "shop-id-for-demo.myshopify.com",
      day: "2026-06-10",
    });
    expect(getRecorded("eq")).toContainEqual(["day", "2026-06-10"]);
    expect(getRecorded("eq")).toContainEqual(["shop_id", "shop-id-for-demo.myshopify.com"]);
  });

  it("blocks at the per-shop limit and inserts nothing", async () => {
    setSupabaseResponses([count(20), count(50)]);
    const res = await checkAndReserveImageGen(SHOP, NOW);
    expect(res).toEqual({ ok: false, scope: "shop", limit: 20 });
    expect(getRecorded("insert")).toHaveLength(0);
  });

  it("blocks at the global limit and inserts nothing", async () => {
    setSupabaseResponses([count(5), count(300)]);
    const res = await checkAndReserveImageGen(SHOP, NOW);
    expect(res).toEqual({ ok: false, scope: "global", limit: 300 });
    expect(getRecorded("insert")).toHaveLength(0);
  });
});

describe("reserveImageGenSlots", () => {
  it("reserves N slots and returns all event ids", async () => {
    setSupabaseResponses([
      count(0), count(0), { data: { id: "e1" }, error: null },
      count(1), count(1), { data: { id: "e2" }, error: null },
    ]);
    const res = await reserveImageGenSlots(SHOP, 2, NOW);
    expect(res).toEqual({ ok: true, eventIds: ["e1", "e2"] });
    expect(getRecorded("insert")).toHaveLength(2);
  });

  it("releases already-reserved slots when blocked partway, and reports the block", async () => {
    setSupabaseResponses([
      count(19), count(10), { data: { id: "e1" }, error: null }, // slot 1 fits (19 -> 20)
      count(20), count(11), // slot 2 blocked at per-shop cap
      { data: null, error: null }, // release of e1
    ]);
    const res = await reserveImageGenSlots(SHOP, 2, NOW);
    expect(res).toEqual({ ok: false, scope: "shop", limit: 20 });
    expect(getRecorded("delete")).toHaveLength(1);
    expect(getRecorded("eq")).toContainEqual(["id", "e1"]);
  });
});

describe("releaseImageGen", () => {
  it("deletes the reserved event row so a failed generation doesn't burn quota", async () => {
    setSupabaseResponses([{ data: null, error: null }]);
    await releaseImageGen("evt-1");
    expect(getRecorded("delete")).toHaveLength(1);
    expect(getRecorded("eq")).toContainEqual(["id", "evt-1"]);
  });

  it("is a no-op without an event id", async () => {
    setSupabaseResponses([]);
    await releaseImageGen(null);
    expect(getRecorded("delete")).toHaveLength(0);
  });
});
