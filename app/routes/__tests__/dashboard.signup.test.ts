import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/lib/dashboard/http.server", () => ({
  rateLimit: vi.fn().mockResolvedValue(true),
  clientIpKey: () => "k",
  requireSameOrigin: vi.fn(),
  checkSameOrigin: vi.fn(() => null),
  wantsJson: (req: Request) => (req.headers.get("Accept") ?? "").includes("application/json"),
  jsonError: (s: number, e: string) => new Response(JSON.stringify({ error: e }), { status: s }),
  publicBaseUrl: () => "https://app.calderyncompany.com",
}));
const findUserByEmail = vi.fn();
const createUser = vi.fn();
const deleteUser = vi.fn();
vi.mock("~/lib/auth/users.server", () => ({
  isValidEmail: (e: string) => /@/.test(e),
  normalizeEmail: (e: string) => e.toLowerCase(),
  findUserByEmail,
  createUser,
  deleteUser,
}));
const provisionOwnedShop = vi.fn().mockResolvedValue({ shopId: "shop1", orgSlug: "acme-x" });
vi.mock("~/lib/auth/tenant.server", () => ({
  provisionOwnedShop,
  linkMembership: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("~/lib/dashboard/session.server", () => ({
  createSessionForUser: vi.fn().mockResolvedValue({ raw: "dash_live_abc" }),
  sessionCookieHeader: () => "__Host-calderyn_dash=dash_live_abc; Path=/",
}));
const sendVerificationEmail = vi.fn();
vi.mock("~/lib/auth/verify.server", () => ({
  sendVerificationEmail: (...a: unknown[]) => sendVerificationEmail(...a),
}));

beforeEach(() => {
  findUserByEmail.mockReset();
  createUser.mockReset();
  deleteUser.mockReset();
  provisionOwnedShop.mockResolvedValue({ shopId: "shop1", orgSlug: "acme-x" });
  sendVerificationEmail.mockReset().mockResolvedValue({ sent: true });
});

function form(fields: Record<string, string>) {
  const body = new URLSearchParams(fields).toString();
  return new Request("https://app.calderyncompany.com/dashboard/signup", {
    method: "POST",
    // Accept: application/json = the JSON error contract these tests pin.
    // (Plain form posts redirect back to /signup?error=… instead.)
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
}

describe("signup action (plain form post)", () => {
  it("redirects back to /signup with the error code instead of raw JSON", async () => {
    const { action } = await import("../dashboard.signup");
    const req = new Request("https://app.calderyncompany.com/dashboard/signup", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "bad", password: "longenough12", store: "Acme" }).toString(),
    });
    const res = (await action({ request: req } as never)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/signup?error=invalid_email&email=bad&store=Acme");
  });
});

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

  it("creates user+shop+membership+session and redirects to the verification gate", async () => {
    findUserByEmail.mockResolvedValue(null);
    createUser.mockResolvedValue({ id: "u1" });
    const { action } = await import("../dashboard.signup");
    const res = (await action({ request: form({ email: "a@b.co", password: "longenough12", store: "Acme" }) } as never)) as Response;
    expect(res.status).toBe(302);
    // A fresh email account is always unverified; /dashboard would only bounce
    // it back here, so the action goes straight to the gate (no double hop).
    expect(res.headers.get("Location")).toBe("/dashboard/verify-needed");
    expect(res.headers.get("Set-Cookie")).toContain("__Host-calderyn_dash=");
  });

  it("lands on the gate with error=send_failed when the verification email does not go out", async () => {
    findUserByEmail.mockResolvedValue(null);
    createUser.mockResolvedValue({ id: "u1" });
    sendVerificationEmail.mockResolvedValue({ sent: false });
    const { action } = await import("../dashboard.signup");
    const res = (await action({ request: form({ email: "a@b.co", password: "longenough12", store: "Acme" }) } as never)) as Response;
    // Send failure must not fail the signup: still 302 with the session cookie.
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/verify-needed?error=send_failed");
    expect(res.headers.get("Set-Cookie")).toContain("__Host-calderyn_dash=");
  });

  it("survives sendVerificationEmail rejecting outright (best-effort send)", async () => {
    findUserByEmail.mockResolvedValue(null);
    createUser.mockResolvedValue({ id: "u1" });
    sendVerificationEmail.mockRejectedValue(new Error("mailer down"));
    const { action } = await import("../dashboard.signup");
    const res = (await action({ request: form({ email: "a@b.co", password: "longenough12", store: "Acme" }) } as never)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/verify-needed?error=send_failed");
  });

  it("rolls back the user and redirects to /signup with a friendly error when provisioning fails (form post)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    findUserByEmail.mockResolvedValue(null);
    createUser.mockResolvedValue({ id: "u2" });
    provisionOwnedShop.mockRejectedValue(new Error("shop insert failed"));
    deleteUser.mockResolvedValue(undefined);
    const { action } = await import("../dashboard.signup");
    const req = new Request("https://app.calderyncompany.com/dashboard/signup", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "a@b.co", password: "longenough12", store: "Acme" }).toString(),
    });
    const res = (await action({ request: req } as never)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "/signup?error=account_creation_failed&email=a%40b.co&store=Acme",
    );
    expect(deleteUser).toHaveBeenCalledWith("u2");
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("returns a 500 error code (not a raw throw) when provisioning fails for a JSON client", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    findUserByEmail.mockResolvedValue(null);
    createUser.mockResolvedValue({ id: "u2" });
    provisionOwnedShop.mockRejectedValue(new Error("shop insert failed"));
    deleteUser.mockResolvedValue(undefined);
    const { action } = await import("../dashboard.signup");
    const res = (await action({ request: form({ email: "a@b.co", password: "longenough12", store: "Acme" }) } as never)) as Response;
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "account_creation_failed" });
    expect(deleteUser).toHaveBeenCalledWith("u2");
    errorSpy.mockRestore();
  });
});
