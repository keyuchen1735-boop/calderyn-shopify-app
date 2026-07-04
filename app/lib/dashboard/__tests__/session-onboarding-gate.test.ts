import { describe, it, expect, vi, beforeEach } from "vitest";

const maybeSingle = vi.fn();
const updateEq = vi.fn().mockResolvedValue({ error: null });
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }), update: () => ({ eq: updateEq }) }),
  }),
  resolveShopId: vi.fn(),
}));
vi.mock("~/lib/actions/snooze.server", () => ({ resurfaceAllSnoozes: vi.fn() }));

process.env.DASHBOARD_SESSION_PEPPER = "x".repeat(32);

function req() {
  return new Request("https://app.x/dashboard", {
    headers: { Cookie: "__Host-calderyn_dash=dash_live_abc" },
  });
}
function row(over: Record<string, unknown>) {
  return {
    data: {
      id: "s1",
      shop_id: "shop1",
      shop_domain: null,
      user_id: "u1",
      expires_at: new Date(Date.now() + 1e6).toISOString(),
      revoked_at: null,
      user: { email_verified: false, onboarded_at: null },
      ...over,
    },
    error: null,
  };
}
beforeEach(() => maybeSingle.mockReset());

describe("onboarding gate", () => {
  it("requireVerifiedSession redirects an un-onboarded first-party session to /dashboard/onboarding (before verify)", async () => {
    maybeSingle.mockResolvedValue(row({})); // user_id set, onboarded_at null, unverified
    const { requireVerifiedSession } = await import("../session.server");
    const err = (await requireVerifiedSession(req()).catch((e) => e)) as Response;
    expect(err.status).toBe(302);
    expect(err.headers.get("Location")).toBe("/dashboard/onboarding");
  });

  it("requireVerifiedSession sends an onboarded-but-unverified user to verify-needed", async () => {
    maybeSingle.mockResolvedValue(
      row({ user: { email_verified: false, onboarded_at: "2026-07-04T00:00:00Z" } }),
    );
    const { requireVerifiedSession } = await import("../session.server");
    const err = (await requireVerifiedSession(req()).catch((e) => e)) as Response;
    expect(err.status).toBe(302);
    expect(err.headers.get("Location")).toBe("/dashboard/verify-needed");
  });

  it("requireVerifiedSession lets a Shopify (user_id null) session through", async () => {
    maybeSingle.mockResolvedValue(row({ user_id: null, shop_domain: "a.myshopify.com", user: null }));
    const { requireVerifiedSession } = await import("../session.server");
    const s = await requireVerifiedSession(req());
    expect(s.onboardedAt).toBeNull();
    expect(s.emailVerified).toBe(true);
  });

  it("requireDashboardSession throws 403 onboarding_required for an un-onboarded first-party session", async () => {
    maybeSingle.mockResolvedValue(row({}));
    const { requireDashboardSession } = await import("../session.server");
    const err = (await requireDashboardSession(req()).catch((e) => e)) as Response;
    expect(err.status).toBe(403);
    expect(await err.json()).toMatchObject({ error: "onboarding_required" });
  });
});
