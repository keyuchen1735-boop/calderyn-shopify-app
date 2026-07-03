// The verification gate polls this probe until the session reports verified
// (the link is often clicked on another device), so it must work for
// UNVERIFIED sessions — a verified-only guard would 403 its entire audience.
import { describe, it, expect, vi, beforeEach } from "vitest";

const getDashboardSessionAllowUnverified = vi.fn();
vi.mock("~/lib/dashboard/session.server", () => ({
  getDashboardSessionAllowUnverified: (...a: unknown[]) => getDashboardSessionAllowUnverified(...a),
}));

beforeEach(() => {
  getDashboardSessionAllowUnverified.mockReset();
});

function args() {
  return {
    request: new Request("https://app.calderyncompany.com/dashboard/api/session-status"),
    params: {},
    context: {},
  } as never;
}

describe("session-status probe", () => {
  it("returns verified:false for a live unverified session", async () => {
    getDashboardSessionAllowUnverified.mockResolvedValue({
      sessionId: "s1",
      userId: "u1",
      shopId: "shop1",
      shopDomain: null,
      emailVerified: false,
    });
    const { loader } = await import("../dashboard.api.session-status");
    const res = (await loader(args())) as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ verified: false });
  });

  it("returns verified:true once the email is confirmed", async () => {
    getDashboardSessionAllowUnverified.mockResolvedValue({
      sessionId: "s1",
      userId: "u1",
      shopId: "shop1",
      shopDomain: null,
      emailVerified: true,
    });
    const { loader } = await import("../dashboard.api.session-status");
    const res = (await loader(args())) as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ verified: true });
  });

  it("surfaces the 401 when there is no live session", async () => {
    getDashboardSessionAllowUnverified.mockRejectedValue(
      new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 }),
    );
    const { loader } = await import("../dashboard.api.session-status");
    await expect(loader(args())).rejects.toMatchObject({ status: 401 });
  });
});
