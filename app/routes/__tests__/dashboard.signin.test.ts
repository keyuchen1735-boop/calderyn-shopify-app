import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/lib/dashboard/http.server", () => ({
  rateLimit: vi.fn().mockResolvedValue(true),
  clientIpKey: () => "k",
  requireSameOrigin: vi.fn(),
  jsonError: (s: number, e: string) => new Response(JSON.stringify({ error: e }), { status: s }),
}));
const verifyUserCredentials = vi.fn();
const resolveShopForUser = vi.fn();
vi.mock("~/lib/auth/users.server", () => ({ verifyUserCredentials, normalizeEmail: (e: string) => e.trim().toLowerCase() }));
vi.mock("~/lib/auth/tenant.server", () => ({ resolveShopForUser }));
vi.mock("~/lib/dashboard/session.server", () => ({
  createSessionForUser: vi.fn().mockResolvedValue({ raw: "dash_live_abc" }),
  sessionCookieHeader: () => "__Host-calderyn_dash=dash_live_abc; Path=/",
}));

beforeEach(() => { verifyUserCredentials.mockReset(); resolveShopForUser.mockReset(); });

function form(fields: Record<string, string>) {
  return new Request("https://app.calderyncompany.com/dashboard/signin", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

describe("signin loader (Shopify-identity fallthrough)", () => {
  it("forwards a visitor carrying the shop-hint cookie to the Shopify OAuth entry", async () => {
    const { loader } = await import("../dashboard.signin");
    const req = new Request("https://app.calderyncompany.com/dashboard/signin", {
      headers: { Cookie: "__Host-dash_shop=acme.myshopify.com" },
    });
    const res = (await loader({ request: req } as never)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/login");
  });

  it("renders the first-party form for a visitor with no shop hint", async () => {
    const { loader } = await import("../dashboard.signin");
    const req = new Request("https://app.calderyncompany.com/dashboard/signin");
    expect(await loader({ request: req } as never)).toBeNull();
  });
});

describe("signin action", () => {
  it("returns 401 invalid_credentials on a bad password", async () => {
    verifyUserCredentials.mockResolvedValue(null);
    const { action } = await import("../dashboard.signin");
    const res = (await action({ request: form({ email: "a@b.co", password: "nope" }) } as never)) as Response;
    expect(res.status).toBe(401);
  });

  it("signs in and redirects on success", async () => {
    verifyUserCredentials.mockResolvedValue({ id: "u1" });
    resolveShopForUser.mockResolvedValue("shop1");
    const { action } = await import("../dashboard.signin");
    const res = (await action({ request: form({ email: "a@b.co", password: "right" }) } as never)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Set-Cookie")).toContain("__Host-calderyn_dash=");
  });
});
