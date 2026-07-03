import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/lib/dashboard/http.server", () => ({
  rateLimit: vi.fn().mockResolvedValue(true),
  checkSameOrigin: vi.fn(() => null),
  requireSameOrigin: vi.fn(),
  wantsJson: (req: Request) => (req.headers.get("Accept") ?? "").includes("application/json"),
  jsonError: (s: number, e: string) => new Response(JSON.stringify({ error: e }), { status: s }),
}));
const revokeSession = vi.fn().mockResolvedValue(undefined);
vi.mock("~/lib/dashboard/session.server", () => ({
  getDashboardSessionAllowUnverified: vi
    .fn()
    .mockResolvedValue({ sessionId: "sess-1", userId: "u1", shopId: "shop1", emailVerified: false }),
  getSessionFromRequest: vi
    .fn()
    .mockResolvedValue({ sessionId: "sess-1", userId: "u1", shopId: "shop1", emailVerified: false }),
  revokeSession,
  clearSessionCookieHeader: () => "__Host-calderyn_dash=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax",
}));
const sendVerificationEmail = vi.fn();
vi.mock("~/lib/auth/verify.server", () => ({
  sendVerificationEmail: (...a: unknown[]) => sendVerificationEmail(...a),
}));
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: { email: "u@example.com" } }) }),
      }),
    }),
  }),
}));

beforeEach(() => {
  sendVerificationEmail.mockReset().mockResolvedValue({ sent: true });
  revokeSession.mockClear();
});

function post(body?: URLSearchParams, accept?: string) {
  return new Request("https://app.calderyncompany.com/dashboard/verify-needed", {
    method: "POST",
    headers: {
      ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      ...(accept ? { Accept: accept } : {}),
    },
    body: body?.toString(),
  });
}

describe("verify-needed action", () => {
  it("does not 500 on a bodyless POST (fetch client without form body)", async () => {
    const { action } = await import("../dashboard.verify-needed");
    const res = (await action({ request: post(undefined, "application/json"), params: {}, context: {} } as never)) as Response;
    expect(res.status).toBe(200);
    expect(sendVerificationEmail).toHaveBeenCalled();
  });

  it("resend redirects with notice=sent only when the mailer accepted the email", async () => {
    const { action } = await import("../dashboard.verify-needed");
    const res = (await action({ request: post(new URLSearchParams()), params: {}, context: {} } as never)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/verify-needed?notice=sent");
  });

  it("surfaces send_failed instead of claiming success when delivery fails", async () => {
    sendVerificationEmail.mockResolvedValue({ sent: false });
    const { action } = await import("../dashboard.verify-needed");
    const res = (await action({ request: post(new URLSearchParams()), params: {}, context: {} } as never)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/verify-needed?error=send_failed");
  });

  it("intent=signout revokes the session and lands on /login with cookies cleared", async () => {
    const { action } = await import("../dashboard.verify-needed");
    const res = (await action({
      request: post(new URLSearchParams({ intent: "signout" })),
      params: {},
      context: {},
    } as never)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login?notice=signed_out");
    expect(revokeSession).toHaveBeenCalledWith("sess-1");
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith("__Host-calderyn_dash="))).toBe(true);
    expect(cookies.some((c) => c.startsWith("__Host-dash_shop="))).toBe(true);
  });
});
