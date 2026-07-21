import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildChain,
  getRecorded,
  setSupabaseResponses,
} from "../../__tests__/_supabase_chain_mock";
import {
  checkAndReserveImageGen,
  completeImageGen,
  markImageGenStarted,
  releaseImageGen,
  reserveImageGenSlots,
} from "../image-gen-limit.server";

vi.mock("../../supabase.server", () => ({
  getSupabase: () => buildChain(),
  resolveShopId: vi.fn(async (domain: string) => `shop-id-for-${domain}`),
}));

const SHOP = "demo.myshopify.com";
const NOW = new Date("2026-06-10T12:00:00.000Z");

beforeEach(() => {
  delete process.env.IMAGE_GEN_DAILY_PER_SHOP;
  delete process.env.IMAGE_GEN_DAILY_GLOBAL;
});

describe("atomic image generation reservations", () => {
  it("reserves one slot through the database function", async () => {
    setSupabaseResponses([
      {
        data: {
          event_ids: ["evt-1"],
          blocked_scope: null,
          limit_value: null,
          remaining: 8,
        },
        error: null,
      },
    ]);

    await expect(checkAndReserveImageGen(SHOP, NOW)).resolves.toEqual({
      ok: true,
      remaining: 8,
      eventId: "evt-1",
    });
    expect(getRecorded("rpc")[0]).toEqual([
      "reserve_image_generation_slots",
      expect.objectContaining({
        p_shop_id: "shop-id-for-demo.myshopify.com",
        p_count: 1,
        p_per_shop_daily: 9,
        p_global_daily: 30,
        p_day: "2026-06-10",
      }),
    ]);
  });

  it("reserves a complete batch with provider metadata", async () => {
    setSupabaseResponses([
      {
        data: {
          event_ids: ["evt-1", "evt-2"],
          blocked_scope: null,
          limit_value: null,
          remaining: 7,
        },
        error: null,
      },
    ]);

    await expect(
      reserveImageGenSlots(SHOP, 2, NOW, {
        generationId: "11111111-1111-1111-1111-111111111111",
        provider: "gemini",
        model: "gemini-3.1-flash-lite-image",
        purpose: "campaign_initial",
      }),
    ).resolves.toEqual({
      ok: true,
      eventIds: ["evt-1", "evt-2"],
      generationId: "11111111-1111-1111-1111-111111111111",
      remaining: 7,
    });
    expect(getRecorded("rpc")[0][1]).toMatchObject({
      p_count: 2,
      p_generation_id: "11111111-1111-1111-1111-111111111111",
      p_provider: "gemini",
      p_model: "gemini-3.1-flash-lite-image",
      p_purpose: "campaign_initial",
    });
  });

  it("applies a per-reservation limits override without touching the defaults", async () => {
    setSupabaseResponses([
      {
        data: {
          event_ids: ["evt-1"],
          blocked_scope: null,
          limit_value: null,
          remaining: 12,
        },
        error: null,
      },
    ]);

    await reserveImageGenSlots(
      SHOP,
      1,
      NOW,
      { provider: "gemini", model: "gemini-3.1-flash-lite-image", purpose: "storefront_design" },
      { perShopDaily: 13 },
    );
    // The override raises only what the caller passed; the global backstop
    // stays the env default.
    expect(getRecorded("rpc")[0][1]).toMatchObject({
      p_per_shop_daily: 13,
      p_global_daily: 30,
    });
  });

  it("returns a hard global block without inserting a partial batch", async () => {
    setSupabaseResponses([
      {
        data: {
          event_ids: [],
          blocked_scope: "global",
          limit_value: 30,
          remaining: 0,
        },
        error: null,
      },
    ]);

    await expect(reserveImageGenSlots(SHOP, 3, NOW)).resolves.toEqual({
      ok: false,
      scope: "global",
      limit: 30,
    });
    expect(getRecorded("rpc")).toHaveLength(1);
    expect(getRecorded("insert")).toHaveLength(0);
  });
});

describe("image generation cost ledger", () => {
  it("marks provider start and stores successful usage", async () => {
    setSupabaseResponses([
      { data: { id: "evt-1" }, error: null },
      { data: { id: "evt-1" }, error: null },
    ]);

    await markImageGenStarted("evt-1");
    await completeImageGen("evt-1", {
      status: "succeeded",
      usage: {
        providerRequestId: "int-1",
        inputTokens: 260,
        outputTokens: 1120,
        thoughtTokens: 0,
        estimatedCostUsdMicros: 33665,
      },
    });

    expect(getRecorded("update")[0][0]).toEqual(
      expect.objectContaining({ provider_started_at: expect.any(String) }),
    );
    expect(getRecorded("update")[1][0]).toEqual(
      expect.objectContaining({
        status: "succeeded",
        provider_request_id: "int-1",
        input_tokens: 260,
        output_tokens: 1120,
        estimated_cost_usd_micros: 33665,
      }),
    );
  });

  it("only releases a reservation that never reached the provider", async () => {
    setSupabaseResponses([{ data: null, error: null }]);
    await releaseImageGen("evt-1");
    expect(getRecorded("delete")).toHaveLength(1);
    expect(getRecorded("eq")).toContainEqual(["status", "reserved"]);
    expect(getRecorded("is")).toContainEqual(["provider_started_at", null]);
  });
});
