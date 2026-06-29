import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/lib/dashboard/http.server", () => ({
  rateLimit: vi.fn().mockResolvedValue(true),
  clientIpKey: () => "k",
  requireSameOrigin: vi.fn(),
  jsonError: (s: number, e: string) => new Response(JSON.stringify({ error: e }), { status: s }),
}));
const findUserByEmail = vi.fn();
const createUser = vi.fn();
vi.mock("~/lib/auth/users.server", () => ({
  isValidEmail: (e: string) => /@/.test(e),
  normalizeEmail: (e: string) => e.toLowerCase(),
  findUserByEmail,
  createUser,
}));
vi.mock("~/lib/auth/tenant.server", () => ({
  provisionOwnedShop: vi.fn().mockResolvedValue({ shopId: "shop1", orgSlug: "acme-x" }),
  linkMembership: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("~/lib/dashboard/session.server", () => ({
  createSessionForUser: vi.fn().mockResolvedValue({ raw: "dash_live_abc" }),
  sessionCookieHeader: () => "__Host-calderyn_dash=dash_live_abc; Path=/",
}));

beforeEach(() => { findUserByEmail.mockReset(); createUser.mockReset(); });

function form(fields: Record<string, string>) {
  const body = new URLSearchParams(fields).toString();
  return new Request("https://app.calderyncompany.com/dashboard/signup", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
}

describe("signup action", () => {
  it("rejects an invalid email with 422", async () => {
    const { action } = await import("../dashboard.signup");
    const res = await action({ request: form({ email: "bad", password: "longenough12", store: "Acme" }) } as never);
    expect((res as Response).status).toBe(422);
  });

  it("rejects a short password with 422", async () => {
    const { action } = await import("../dashboard.signup");
    const res = await action({ request: form({ email: "a@b.co", password: "short", store: "Acme" }) } as never);
    expect((res as Response).status).toBe(422);
  });

  it("rejects a duplicate email with 409", async () => {
    findUserByEmail.mockResolvedValue({ id: "u0", passwordHash: "h" });
    const { action } = await import("../dashboard.signup");
    const res = await action({ request: form({ email: "a@b.co", password: "longenough12", store: "Acme" }) } as never);
    expect((res as Response).status).toBe(409);
  });

  it("creates user+shop+membership+session and redirects on success", async () => {
    findUserByEmail.mockResolvedValue(null);
    createUser.mockResolvedValue({ id: "u1" });
    const { action } = await import("../dashboard.signup");
    const res = (await action({ request: form({ email: "a@b.co", password: "longenough12", store: "Acme" }) } as never)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard");
    expect(res.headers.get("Set-Cookie")).toContain("__Host-calderyn_dash=");
  });
});
