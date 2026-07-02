import { describe, it, expect, vi, beforeEach } from "vitest";
import { routeArgs } from "../../__tests__/_route-test-helpers";

import { loader as analyticsLoader } from "../../../routes/dashboard.api.analytics";

const requireDashboardSession = vi.fn();
const dailyRoasSeries = vi.fn();
const campaignGrades = vi.fn();
const topAdsByEngagement = vi.fn();

vi.mock("../session.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session.server")>()),
  requireDashboardSession: (...a: unknown[]) => requireDashboardSession(...a),
}));
vi.mock("../../supabase.server", () => ({ getSupabase: () => ({}) }));
vi.mock("../../meta/ad-create.server", () => ({ metaDraftPushEnabled: vi.fn(async () => false) }));
vi.mock("../../calderyn.server", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../calderyn.server")>();
  return {
    ...orig,
    calderynClient: () => ({
      analytics: {
        dailyRoasSeries: (...a: unknown[]) => dailyRoasSeries(...a),
        campaignGrades: (...a: unknown[]) => campaignGrades(...a),
        topAdsByEngagement: (...a: unknown[]) => topAdsByEngagement(...a),
      },
    }),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  requireDashboardSession.mockResolvedValue({
    shopId: "shop-1",
    shopDomain: "x.myshopify.com",
    sessionId: "sess-1",
  });
});

describe("GET /dashboard/api/analytics", () => {
  it("propagates the 401 thrown by the session guard", async () => {
    requireDashboardSession.mockRejectedValueOnce(
      new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 }),
    );
    await expect(
      analyticsLoader(routeArgs({
        request: new Request("https://calderyncompany.com/dashboard/api/analytics"),
        params: {},
        context: {},
      })),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("returns roas series, grades, and top ads scoped to the shop", async () => {
    dailyRoasSeries.mockResolvedValueOnce([{ day: "2026-06-01", spend_cents: 100, revenue_cents: 300 }]);
    campaignGrades.mockResolvedValueOnce([{ campaign_id: "c1", grade: "winning", break_even_roas: 1.8 }]);
    topAdsByEngagement.mockResolvedValueOnce([{ ad_external_id: "ad1", engagement: 42 }]);

    const res = (await analyticsLoader(routeArgs({
      request: new Request("https://calderyncompany.com/dashboard/api/analytics"),
      params: {},
      context: {},
    }))) as Response;

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({
      roas_series: [{ day: "2026-06-01", spend_cents: 100, revenue_cents: 300 }],
      grades: [{ campaign_id: "c1", grade: "winning", break_even_roas: 1.8 }],
      top_ads: [{ ad_external_id: "ad1", engagement: 42 }],
      meta_can_push_drafts: false,
    });
    expect(dailyRoasSeries).toHaveBeenCalledWith(30);
    expect(topAdsByEngagement).toHaveBeenCalledWith(30, 10);
  });
});
