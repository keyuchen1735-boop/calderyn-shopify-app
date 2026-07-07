import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActionFunctionArgs } from "@remix-run/node";
import type * as SessionServer from "~/lib/dashboard/session.server";
// vi.mock is hoisted above these imports, so the mocks apply before the route
// module is evaluated.
import { action } from "../dashboard.api.account";

// Spies live in vi.hoisted so the mock factories below can close over them.
const { sessionMock, deleteAccountMock, rateLimitMock, isShowcaseMock } = vi.hoisted(() => ({
  sessionMock: vi.fn(),
  deleteAccountMock: vi.fn(),
  rateLimitMock: vi.fn(),
  isShowcaseMock: vi.fn(),
}));

// Keep the real cookie helpers (clearSessionCookieHeader) — only the session
// read is stubbed so we can drive the account type / verified state.
vi.mock("~/lib/dashboard/session.server", async (importOriginal) => ({
  ...(await importOriginal<typeof SessionServer>()),
  getDashboardSessionAllowUnverified: (...a: unknown[]) => sessionMock(...a),
}));
vi.mock("~/lib/auth/delete-account.server", () => ({
  deleteAccount: (...a: unknown[]) => deleteAccountMock(...a),
}));
vi.mock("~/lib/rate-limit.server", () => ({
  rateLimit: (...a: unknown[]) => rateLimitMock(...a),
  clientIpKey: () => "ip",
}));
vi.mock("~/lib/demo/showcase.server", () => ({
  isShowcaseShop: (...a: unknown[]) => isShowcaseMock(...a),
}));
// delete-account.server is mocked, but the route's transitive imports still pull
// supabase.server at load — stub it so no real client init runs in tests.
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({}), resolveShopId: vi.fn() }));

const ORIGIN = "https://calderyncompany.com";
const SESSION_COOKIE = "__Host-calderyn_dash";

function post(body: unknown, origin: string | null = ORIGIN, method = "POST"): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (origin) headers.Origin = origin;
  return new Request(`${ORIGIN}/dashboard/api/account`, {
    method,
    headers,
    body: JSON.stringify(body),
  });
}

function run(request: Request) {
  return action({ request, params: {}, context: {} } as ActionFunctionArgs) as Promise<Response>;
}

beforeEach(() => {
  sessionMock.mockReset().mockResolvedValue({ userId: "u1", shopId: "shop1", shopDomain: null });
  deleteAccountMock.mockReset().mockResolvedValue({ shopDeleted: true });
  rateLimitMock.mockReset().mockResolvedValue(true);
  isShowcaseMock.mockReset().mockResolvedValue(false);
  // requireSameOrigin reads this to build its allowlist.
  process.env.DASHBOARD_PUBLIC_URL = ORIGIN;
});

describe("POST /dashboard/api/account (delete)", () => {
  it("deletes the account and clears the session cookie on a valid DELETE confirm", async () => {
    const res = await run(post({ intent: "delete", confirm: "DELETE" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(deleteAccountMock).toHaveBeenCalledWith("u1", "shop1");
    expect(
      res.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=;`) && c.includes("Max-Age=0")),
    ).toBe(true);
  });

  it("rejects a wrong confirmation without deleting", async () => {
    const res = await run(post({ intent: "delete", confirm: "delete" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("confirmation_required");
    expect(deleteAccountMock).not.toHaveBeenCalled();
  });

  it("rejects a legacy Shopify (non-first-party) session", async () => {
    sessionMock.mockResolvedValue({ userId: null, shopId: "shop1", shopDomain: "x.myshopify.com" });
    const res = await run(post({ intent: "delete", confirm: "DELETE" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("not_first_party");
    expect(deleteAccountMock).not.toHaveBeenCalled();
  });

  it("rejects a non-POST method", async () => {
    const res = await run(post({ confirm: "DELETE" }, ORIGIN, "PUT"));
    expect(res.status).toBe(405);
    expect(deleteAccountMock).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin request (CSRF guard)", async () => {
    // requireSameOrigin throws the 403 Response (resource-route form); Remix
    // surfaces it, so here we catch it directly.
    const res = await run(post({ confirm: "DELETE" }, "https://evil.example")).catch(
      (e) => e as Response,
    );
    expect(res.status).toBe(403);
    expect(deleteAccountMock).not.toHaveBeenCalled();
  });

  it("refuses to delete a demo/showcase shop (shared login can't self-destruct)", async () => {
    isShowcaseMock.mockResolvedValue(true);
    const res = await run(post({ intent: "delete", confirm: "DELETE" }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("demo_shop_protected");
    expect(deleteAccountMock).not.toHaveBeenCalled();
  });

  it("returns 429 when the rate limit is exceeded", async () => {
    rateLimitMock.mockResolvedValue(false);
    const res = await run(post({ intent: "delete", confirm: "DELETE" }));
    expect(res.status).toBe(429);
    expect(deleteAccountMock).not.toHaveBeenCalled();
  });
});
