import { describe, it, expect, vi, beforeEach } from "vitest";
import { action } from "../app.autopilot.run";

// Hoisted mocks: the embedded admin session (App Bridge token auth), the shop-id
// resolver, the Supabase factory, and the autopilot engine. The route's job is
// to authenticate, resolve session.shop → shopId, and hand that to
// runAutopilotForShop — the engine itself is tested in
// app/lib/actions/__tests__/autopilot.test.ts.
const { authenticate, resolveShopId, getSupabase, runAutopilotForShop } = vi.hoisted(() => ({
  authenticate: { admin: vi.fn() },
  resolveShopId: vi.fn(),
  getSupabase: vi.fn(() => ({ marker: "sb" })),
  runAutopilotForShop: vi.fn(),
}));
vi.mock("~/shopify.server", () => ({ authenticate }));
vi.mock("~/lib/supabase.server", () => ({ resolveShopId, getSupabase }));
vi.mock("~/lib/actions/autopilot.server", () => ({ runAutopilotForShop }));

const SHOP_DOMAIN = "demo.myshopify.com";
const SHOP_ID = "00000000-0000-0000-0000-000000000010";
const SUMMARY = {
  skipped: false,
  acted: 2,
  blocked: 0,
  failed: 0,
  considered: 2,
  blockedReasons: {},
  decisions: [
    { alertId: "al1", campaignId: "c1", detectorId: "campaign_below_breakeven", intendedKind: "pause_campaign", outcome: "acted", reason: "pause_campaign" },
  ],
};

function post(): Request {
  return new Request("https://admin.shopify.test/app/autopilot/run", { method: "POST" });
}

describe("app.autopilot.run action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticate.admin.mockResolvedValue({ session: { shop: SHOP_DOMAIN } });
    resolveShopId.mockResolvedValue(SHOP_ID);
    runAutopilotForShop.mockResolvedValue(SUMMARY);
  });

  it("authenticates, resolves the shop, runs autopilot, and returns the summary", async () => {
    const res = await action({ request: post(), params: {}, context: {} } as never);
    expect(authenticate.admin).toHaveBeenCalledTimes(1);
    expect(resolveShopId).toHaveBeenCalledWith(SHOP_DOMAIN);
    expect(runAutopilotForShop).toHaveBeenCalledWith(SHOP_ID, { marker: "sb" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SUMMARY);
  });

  it("propagates an auth bounce (thrown Response) without running autopilot", async () => {
    authenticate.admin.mockRejectedValue(new Response("redirect", { status: 302 }));
    const res = await action({ request: post(), params: {}, context: {} } as never).catch(
      (thrown: Response) => thrown,
    );
    expect((res as Response).status).toBe(302);
    expect(resolveShopId).not.toHaveBeenCalled();
    expect(runAutopilotForShop).not.toHaveBeenCalled();
  });

  it("returns a JSON error instead of throwing when the engine fails (so the fetcher can surface it, not crash the page)", async () => {
    runAutopilotForShop.mockRejectedValue(new Error("supabase down"));
    const res = await action({ request: post(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { error?: string; acted: number; decisions: unknown[] };
    expect(body.error).toContain("supabase down");
    expect(body.acted).toBe(0);
    expect(body.decisions).toEqual([]);
  });
});
