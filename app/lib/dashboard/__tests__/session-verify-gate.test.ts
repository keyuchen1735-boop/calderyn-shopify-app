import { describe, it, expect, vi, beforeEach } from "vitest";

const maybeSingle = vi.fn();
const updateEq = vi.fn().mockResolvedValue({ error: null });
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }), update: () => ({ eq: updateEq }) }) }),
  resolveShopId: vi.fn(),
}));
vi.mock("~/lib/actions/snooze.server", () => ({ resurfaceAllSnoozes: vi.fn() }));

process.env.DASHBOARD_SESSION_PEPPER = "x".repeat(32);

function reqWithCookie() {
  return new Request("https://app.x/dashboard/api/me", { headers: { Cookie: "__Host-calderyn_dash=dash_live_abc" } });
}
beforeEach(() => { maybeSingle.mockReset(); });

describe("verify gate", () => {
  it("requireDashboardSession throws 403 email_unverified for an unverified first-party session", async () => {
    maybeSingle.mockResolvedValue({ data: { id: "s1", shop_id: "shop1", shop_domain: null, user_id: "u1", expires_at: new Date(Date.now()+1e6).toISOString(), revoked_at: null, user: { email_verified: false } }, error: null });
    const { requireDashboardSession } = await import("../session.server");
    await expect(requireDashboardSession(reqWithCookie())).rejects.toMatchObject({ status: 403 });
  });

  it("requireDashboardSession allows a Shopify session (user_id null => emailVerified true)", async () => {
    maybeSingle.mockResolvedValue({ data: { id: "s1", shop_id: "shop1", shop_domain: "a.myshopify.com", user_id: null, expires_at: new Date(Date.now()+1e6).toISOString(), revoked_at: null, user: null }, error: null });
    const { requireDashboardSession } = await import("../session.server");
    const s = await requireDashboardSession(reqWithCookie());
    expect(s.emailVerified).toBe(true);
  });

  it("getDashboardSessionAllowUnverified returns the unverified session without throwing", async () => {
    maybeSingle.mockResolvedValue({ data: { id: "s1", shop_id: "shop1", shop_domain: null, user_id: "u1", expires_at: new Date(Date.now()+1e6).toISOString(), revoked_at: null, user: { email_verified: false } }, error: null });
    const { getDashboardSessionAllowUnverified } = await import("../session.server");
    const s = await getDashboardSessionAllowUnverified(reqWithCookie());
    expect(s.emailVerified).toBe(false);
  });
});
