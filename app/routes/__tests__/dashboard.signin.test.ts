import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/lib/dashboard/http.server", () => ({
  rateLimit: vi.fn().mockResolvedValue(true),
  clientIpKey: () => "k",
  checkSameOrigin: vi.fn(() => null),
  requireSameOrigin: vi.fn(),
  wantsJson: (req: Request) => (req.headers.get("Accept") ?? "").includes("application/json"),
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

function form(fields: Record<string, string>, accept?: string) {
  return new Request("https://app.calderyncompany.com/dashboard/signin", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(accept ? { Accept: accept } : {}),
    },
    body: new URLSearchParams(fields).toString(),
  });
}

describe("signin endpoint GET", () => {
  it("redirects to the /login page, preserving query params", async () => {
    const { loader } = await import("../dashboard.signin");
    const req = new Request("https://app.calderyncompany.com/dashboard/signin?error=no_shop&email=a%40b.co");
    const res = (await loader({ request: req } as never)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login?error=no_shop&email=a%40b.co");
  });
});

describe("login page loader (Shopify-identity fallthrough)", () => {
  it("forwards a visitor carrying the shop-hint cookie to the Shopify OAuth entry", async () => {
    const { loader } = await import("../login");
    const req = new Request("https://app.calderyncompany.com/login", {
      headers: { Cookie: "__Host-dash_shop=acme.myshopify.com" },
    });
    const res = (await loader({ request: req } as never)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/login");
  });

  it("never bounces when the visit carries an error to show", async () => {
    const { loader } = await import("../login");
    const req = new Request("https://app.calderyncompany.com/login?error=invalid_credentials", {
      headers: { Cookie: "__Host-dash_shop=acme.myshopify.com" },
    });
    const data = (await loader({ request: req } as never)) as { error: string | null };
    expect(data.error).toBe("invalid_credentials");
  });

  it("renders the form for a visitor with no shop hint", async () => {
    const { loader } = await import("../login");
    const req = new Request("https://app.calderyncompany.com/login");
    const data = (await loader({ request: req } as never)) as { error: string | null; email: string };
    expect(data.error).toBeNull();
    expect(data.email).toBe("");
  });
});

describe("signin action", () => {
  it("returns 401 invalid_credentials JSON for fetch clients", async () => {
    verifyUserCredentials.mockResolvedValue(null);
    const { action } = await import("../dashboard.signin");
    const res = (await action({ request: form({ email: "a@b.co", password: "nope" }, "application/json") } as never)) as Response;
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("invalid_credentials");
  });

  it("redirects a plain form post back to /login with the error code (never raw JSON)", async () => {
    verifyUserCredentials.mockResolvedValue(null);
    const { action } = await import("../dashboard.signin");
    const res = (await action({ request: form({ email: "a@b.co", password: "nope" }) } as never)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login?error=invalid_credentials&email=a%40b.co");
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
