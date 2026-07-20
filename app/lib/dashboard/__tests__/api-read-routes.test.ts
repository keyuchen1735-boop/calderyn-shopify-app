import { describe, it, expect, vi, beforeEach } from "vitest";

import { CalderynError } from "../../calderyn.server";
import { loader as campaignsLoader } from "../../../routes/dashboard.api.campaigns._index";
import { loader as campaignLoader } from "../../../routes/dashboard.api.campaigns.$id";

const requireDashboardSession = vi.fn();
const campaignsPerformance = vi.fn();
const campaignsGet = vi.fn();
const campaignGrades = vi.fn();

vi.mock("../session.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session.server")>()),
  requireDashboardSession: (...a: unknown[]) => requireDashboardSession(...a),
}));
vi.mock("../../calderyn.server", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../calderyn.server")>();
  return {
    ...orig,
    calderynClient: () => ({
      campaigns: {
        performance: (...a: unknown[]) => campaignsPerformance(...a),
        get: (...a: unknown[]) => campaignsGet(...a),
      },
      analytics: {
        campaignGrades: (...a: unknown[]) => campaignGrades(...a),
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
  campaignGrades.mockResolvedValue([]);
});

describe("GET /dashboard/api/campaigns", () => {
  it("propagates the 401 thrown by the session guard", async () => {
    requireDashboardSession.mockRejectedValueOnce(
      new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 }),
    );
    await expect(
      campaignsLoader({
        request: new Request("https://calderyncompany.com/dashboard/api/campaigns"),
        params: {},
        context: {},
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("uses the requested metric window and preserves nullable profit", async () => {
    campaignsPerformance.mockResolvedValueOnce([{
      id: "c1", name: "BFCM", platform: "Meta", status: "active",
      daily_budget_cents: 5000, campaign_kind: "sales", sale_type: "Black Friday",
      classification_source: "detected", orders: 12, revenue_cents: 48000,
      spend_cents: 12000, profit_cents: null, true_roas: 4,
      cost_complete: false, cost_sources: ["quickbooks"],
    }]);
    const res = (await campaignsLoader({
      request: new Request("https://calderyncompany.com/dashboard/api/campaigns?window=30"),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(campaignsPerformance).toHaveBeenCalledWith(30);
    expect((await res.json()).campaigns[0]).toMatchObject({
      id: "c1",
      profit_cents: null,
    });
  });

  it("defaults an omitted metric window to 30 days", async () => {
    campaignsPerformance.mockResolvedValueOnce([]);
    const res = (await campaignsLoader({
      request: new Request("https://calderyncompany.com/dashboard/api/campaigns"),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(200);
    expect(campaignsPerformance).toHaveBeenCalledWith(30);
  });

  it("rejects unsupported metric windows before loading campaigns", async () => {
    const res = (await campaignsLoader({
      request: new Request("https://calderyncompany.com/dashboard/api/campaigns?window=14"),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_window" });
    expect(campaignsPerformance).not.toHaveBeenCalled();
  });

  it("rejects numeric lookalikes outside the exact window values", async () => {
    const res = (await campaignsLoader({
      request: new Request("https://calderyncompany.com/dashboard/api/campaigns?window=30.0"),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(400);
    expect(campaignsPerformance).not.toHaveBeenCalled();
  });
});

describe("GET /dashboard/api/campaigns/:id", () => {
  it("maps CalderynError to its status and code", async () => {
    campaignsGet.mockRejectedValueOnce(
      new CalderynError({ code: "CAMPAIGN_NOT_FOUND", status: 404, message: "nope" }),
    );
    const res = (await campaignLoader({
      request: new Request("https://calderyncompany.com/dashboard/api/campaigns/c9"),
      params: { id: "c9" },
      context: {},
    })) as Response;
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "CAMPAIGN_NOT_FOUND", message: "nope" });
  });
});
