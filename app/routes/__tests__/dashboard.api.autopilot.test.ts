import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { action } from "../dashboard.api.autopilot";

// Hoisted mocks: the dashboard session (cookie auth), the autopilot engine, and
// the Supabase client factory. vi.mock is hoisted above the imports by Vitest,
// so the mocks still apply to the `action` import above. The route's job is to
// wire session.shopId into runAutopilotForShop and return its summary — the
// engine itself is tested in app/lib/actions/__tests__/autopilot.test.ts.
const { requireDashboardSession, runAutopilotForShop, getSupabase } = vi.hoisted(() => ({
  requireDashboardSession: vi.fn(),
  runAutopilotForShop: vi.fn(),
  getSupabase: vi.fn(() => ({ marker: "sb" })),
}));
vi.mock("~/lib/dashboard/session.server", () => ({ requireDashboardSession }));
vi.mock("~/lib/actions/autopilot.server", () => ({ runAutopilotForShop }));
vi.mock("~/lib/supabase.server", () => ({ getSupabase }));

const SHOP = "00000000-0000-0000-0000-000000000010";
const ORIGIN = "https://app.example.test";

function request(method = "POST", origin: string | null = ORIGIN): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (origin) headers.Origin = origin;
  return new Request(`${ORIGIN}/dashboard/api/autopilot`, { method, headers });
}

const SUMMARY = {
  skipped: false,
  acted: 2,
  blocked: 1,
  failed: 0,
  considered: 3,
  blockedReasons: { "daily action cap reached": 1 },
  decisions: [
    { alertId: "al1", campaignId: "c1", detectorId: "campaign_below_breakeven", intendedKind: "pause_campaign", outcome: "acted", reason: "pause_campaign" },
  ],
};

describe("dashboard.api.autopilot action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("SHOPIFY_APP_URL", ORIGIN);
    requireDashboardSession.mockResolvedValue({ shopId: SHOP, shopDomain: "x.myshopify.com", sessionId: "s" });
    runAutopilotForShop.mockResolvedValue(SUMMARY);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("runs autopilot for the session's shop and returns the summary", async () => {
    const res = await action({ request: request(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(runAutopilotForShop).toHaveBeenCalledWith(SHOP, { marker: "sb" });
    expect(await res.json()).toEqual(SUMMARY);
  });

  it("rejects a cross-origin POST (CSRF) before running autopilot", async () => {
    const res = await action({
      request: request("POST", "https://evil.example"),
      params: {},
      context: {},
    } as never).catch((thrown: Response) => thrown);
    expect((res as Response).status).toBe(403);
    expect(runAutopilotForShop).not.toHaveBeenCalled();
  });

  it("returns 405 for a non-POST method", async () => {
    const res = await action({ request: request("PUT"), params: {}, context: {} } as never);
    expect(res.status).toBe(405);
    expect(runAutopilotForShop).not.toHaveBeenCalled();
  });

  it("propagates the 401 from an unauthenticated session", async () => {
    requireDashboardSession.mockRejectedValue(new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 }));
    const res = await action({ request: request(), params: {}, context: {} } as never).catch(
      (thrown: Response) => thrown,
    );
    expect((res as Response).status).toBe(401);
    expect(runAutopilotForShop).not.toHaveBeenCalled();
  });
});
