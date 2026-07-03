import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as HttpMod from "~/lib/dashboard/http.server";

vi.mock("~/lib/dashboard/http.server", async (importOriginal) => ({
  ...(await importOriginal<typeof HttpMod>()),
  rateLimit: vi.fn().mockResolvedValue(true),
  clientIpKey: () => "k",
  checkSameOrigin: vi.fn(() => null),
  requireSameOrigin: vi.fn(),
}));
const verifyUserCredentials = vi.fn();
const resolveShopForUser = vi.fn();
const getSessionFromRequest = vi.fn();
vi.mock("~/lib/auth/users.server", () => ({ verifyUserCredentials, normalizeEmail: (e: string) => e.trim().toLowerCase() }));
vi.mock("~/lib/auth/tenant.server", () => ({ resolveShopForUser }));
vi.mock("~/lib/dashboard/session.server", () => ({
  createSessionForUser: vi.fn().mockResolvedValue({ raw: "dash_live_abc" }),
  sessionCookieHeader: () => "__Host-calderyn_dash=dash_live_abc; Path=/",
  getSessionFromRequest: (...a: unknown[]) => getSessionFromRequest(...a),
}));

beforeEach(() => {
  verifyUserCredentials.mockReset();
  resolveShopForUser.mockReset();
  getSessionFromRequest.mockReset().mockResolvedValue(null);
});

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

  it("sends an already-signed-in visitor straight to the dashboard", async () => {
    getSessionFromRequest.mockResolvedValue({ sessionId: "s1", shopId: "shop1", userId: "u1", emailVerified: true });
    const { loader } = await import("../dashboard.signin");
    const res = (await loader({ request: new Request("https://app.calderyncompany.com/dashboard/signin") } as never)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard");
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

  it("signs in, clears the Shopify shop hint, and redirects on success", async () => {
    verifyUserCredentials.mockResolvedValue({ id: "u1" });
    resolveShopForUser.mockResolvedValue("shop1");
    const { action } = await import("../dashboard.signin");
    const res = (await action({ request: form({ email: "a@b.co", password: "right" }) } as never)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard");
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith("__Host-calderyn_dash="))).toBe(true);
    // First-party sign-in must drop any stale Shopify hint so the old silent
    // OAuth bounce can never resurrect.
    expect(cookies.some((c) => c.startsWith("__Host-dash_shop=") && c.includes("Max-Age=0"))).toBe(true);
  });

  it("honours a validated return_to and rejects hostile ones", async () => {
    verifyUserCredentials.mockResolvedValue({ id: "u1" });
    resolveShopForUser.mockResolvedValue("shop1");
    const { action } = await import("../dashboard.signin");

    const ok = (await action({
      request: form({ email: "a@b.co", password: "right", return_to: "/dashboard/connect?t=tok" }),
    } as never)) as Response;
    expect(ok.headers.get("Location")).toBe("/dashboard/connect?t=tok");

    for (const evil of ["https://evil.com/x", "//evil.com", "/notdashboard", "/dashboard/\\evil"]) {
      const res = (await action({
        request: form({ email: "a@b.co", password: "right", return_to: evil }),
      } as never)) as Response;
      expect(res.headers.get("Location"), `return_to=${evil} must fall back`).toBe("/dashboard");
    }
  });
});

describe("login page loader", () => {
  it("never bounces into Shopify OAuth — a shop hint stays a hint", async () => {
    const { loader } = await import("../login");
    const req = new Request("https://app.calderyncompany.com/login", {
      headers: { Cookie: "__Host-dash_shop=acme.myshopify.com" },
    });
    const data = (await loader({ request: req } as never)) as { error: string | null };
    // Data (the form renders), NOT a redirect response.
    expect(data).not.toBeInstanceOf(Response);
    expect(data.error).toBeNull();
  });

  it("sends an already-signed-in visitor to the dashboard", async () => {
    getSessionFromRequest.mockResolvedValue({ sessionId: "s1", shopId: "shop1", userId: "u1", emailVerified: true });
    const { loader } = await import("../login");
    const res = (await loader({ request: new Request("https://app.calderyncompany.com/login") } as never)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard");
  });

  it("exposes error, email, and validated return_to to the page", async () => {
    const { loader } = await import("../login");
    const req = new Request(
      "https://app.calderyncompany.com/login?error=invalid_credentials&email=a%40b.co&return_to=%2Fdashboard%2Fconnect%3Ft%3Dtok",
    );
    const data = (await loader({ request: req } as never)) as {
      error: string | null;
      email: string;
      returnTo: string | null;
    };
    expect(data.error).toBe("invalid_credentials");
    expect(data.email).toBe("a@b.co");
    expect(data.returnTo).toBe("/dashboard/connect?t=tok");
  });

  it("drops a hostile return_to instead of passing it to the form", async () => {
    const { loader } = await import("../login");
    const req = new Request("https://app.calderyncompany.com/login?return_to=https%3A%2F%2Fevil.com");
    const data = (await loader({ request: req } as never)) as { returnTo: string | null };
    expect(data.returnTo).toBeNull();
  });
});
