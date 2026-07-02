import { describe, it, expect, vi, beforeEach } from "vitest";
import { routeArgs } from "../../__tests__/_route-test-helpers";

import { CalderynError } from "../../calderyn.server";
import { loader as campaignsLoader } from "../../../routes/dashboard.api.campaigns._index";
import { loader as campaignLoader } from "../../../routes/dashboard.api.campaigns.$id";

const requireDashboardSession = vi.fn();
const campaignsList = vi.fn();
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
        list: (...a: unknown[]) => campaignsList(...a),
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
      campaignsLoader(routeArgs({
        request: new Request("https://calderyncompany.com/dashboard/api/campaigns"),
        params: {},
        context: {},
      })),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("returns the shop's campaigns as JSON", async () => {
    campaignsList.mockResolvedValueOnce([{ id: "c1", name: "Spring" }]);
    const res = (await campaignsLoader(routeArgs({
      request: new Request("https://calderyncompany.com/dashboard/api/campaigns"),
      params: {},
      context: {},
    }))) as Response;
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({
      campaigns: [
        {
          id: "c1",
          name: "Spring",
          calderynScore: {
            value: null,
            band: "nodata",
            performance: null,
            creative: null,
            confidence: "low",
            weakDimensions: [],
            tips: [],
            adsCovered: 0,
            adsTotal: 0,
          },
        },
      ],
    });
  });
});

describe("GET /dashboard/api/campaigns/:id", () => {
  it("maps CalderynError to its status and code", async () => {
    campaignsGet.mockRejectedValueOnce(
      new CalderynError({ code: "CAMPAIGN_NOT_FOUND", status: 404, message: "nope" }),
    );
    const res = (await campaignLoader(routeArgs({
      request: new Request("https://calderyncompany.com/dashboard/api/campaigns/c9"),
      params: { id: "c9" },
      context: {},
    }))) as Response;
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "CAMPAIGN_NOT_FOUND", message: "nope" });
  });
});
