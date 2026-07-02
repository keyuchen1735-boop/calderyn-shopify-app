// app/lib/dashboard/__tests__/api-analytics-live-route.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

import { loader as liveLoader } from "../../../routes/dashboard.api.analytics-live";

const requireDashboardSession = vi.fn();
const buildLiveSnapshot = vi.fn();

vi.mock("../session.server", async (importOriginal) => ({
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- vi.mock's importOriginal generic requires the inline import() type (same as the sibling route tests)
  ...(await importOriginal<typeof import("../session.server")>()),
  requireDashboardSession: (...a: unknown[]) => requireDashboardSession(...a),
}));
vi.mock("../../supabase.server", () => ({ getSupabase: () => ({}) }));
vi.mock("../live-analytics.server", () => ({
  buildLiveSnapshot: (...a: unknown[]) => buildLiveSnapshot(...a),
}));

beforeEach(() => {
  vi.clearAllMocks();
  requireDashboardSession.mockResolvedValue({
    shopId: "shop-1",
    shopDomain: "x.myshopify.com",
    sessionId: "sess-1",
  });
});

describe("GET /dashboard/api/analytics-live", () => {
  it("propagates the 401 thrown by the session guard", async () => {
    requireDashboardSession.mockRejectedValueOnce(
      new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 }),
    );
    await expect(
      liveLoader({
        request: new Request("https://calderyncompany.com/dashboard/api/analytics-live"),
        params: {},
        context: {},
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("returns the snapshot DTO scoped to the shop", async () => {
    buildLiveSnapshot.mockResolvedValueOnce({ visitors_now: 3, sessions_today: 9 });
    const res = (await liveLoader({
      request: new Request("https://calderyncompany.com/dashboard/api/analytics-live"),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ visitors_now: 3, sessions_today: 9 });
    expect(buildLiveSnapshot).toHaveBeenCalledWith({}, "shop-1");
  });
});
