import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as HttpMod from "~/lib/dashboard/http.server";

vi.mock("~/lib/dashboard/http.server", async (importOriginal) => ({
  ...(await importOriginal<typeof HttpMod>()),
  rateLimit: vi.fn().mockResolvedValue(true),
  clientIpKey: () => "k",
  requireSameOrigin: vi.fn(),
}));
const activateRememberedAccount = vi.fn();
const forgetRememberedAccount = vi.fn();
vi.mock("~/lib/auth/remembered-accounts.server", () => ({
  activateRememberedAccount: (...a: unknown[]) => activateRememberedAccount(...a),
  forgetRememberedAccount: (...a: unknown[]) => forgetRememberedAccount(...a),
  rememberOnSignIn: () => "__Host-calderyn_accounts=dash_live_x; Path=/",
}));
vi.mock("~/lib/dashboard/session.server", () => ({
  sessionCookieHeader: (raw: string) => `__Host-calderyn_dash=${raw}; Path=/`,
}));

beforeEach(() => {
  activateRememberedAccount.mockReset();
  forgetRememberedAccount.mockReset();
});

const SID = "a".repeat(16);

function form(fields: Record<string, string>) {
  return new Request("https://app.calderyncompany.com/dashboard/api/switch-account", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

describe("switch-account action", () => {
  it("activates a live remembered session and lands on the dashboard", async () => {
    activateRememberedAccount.mockResolvedValue({ ok: true, raw: "dash_live_ok", cookieHeader: null });
    const { action } = await import("../dashboard.api.switch-account");
    const res = (await action({ request: form({ sid: SID }) } as never)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard");
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith("__Host-calderyn_dash=dash_live_ok"))).toBe(true);
  });

  it("honours a validated return_to on switch", async () => {
    activateRememberedAccount.mockResolvedValue({ ok: true, raw: "dash_live_ok", cookieHeader: null });
    const { action } = await import("../dashboard.api.switch-account");
    const res = (await action({
      request: form({ sid: SID, return_to: "/dashboard/connect?t=tok" }),
    } as never)) as Response;
    expect(res.headers.get("Location")).toBe("/dashboard/connect?t=tok");
  });

  it("falls back to the password form (email prefilled) when the session died", async () => {
    activateRememberedAccount.mockResolvedValue({
      ok: false,
      email: "a@b.co",
      cookieHeader: "__Host-calderyn_accounts=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax",
    });
    const { action } = await import("../dashboard.api.switch-account");
    const res = (await action({ request: form({ sid: SID }) } as never)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login?error=session_expired&email=a%40b.co");
    expect(res.headers.getSetCookie().some((c) => c.includes("Max-Age=0"))).toBe(true);
  });

  it("bounces malformed sids back to /login without touching the DB", async () => {
    const { action } = await import("../dashboard.api.switch-account");
    const res = (await action({ request: form({ sid: "../../etc" }) } as never)) as Response;
    expect(res.headers.get("Location")).toBe("/login");
    expect(activateRememberedAccount).not.toHaveBeenCalled();
  });

  it("remove intent forgets the entry and returns to the chooser", async () => {
    forgetRememberedAccount.mockResolvedValue("__Host-calderyn_accounts=rest; Path=/");
    const { action } = await import("../dashboard.api.switch-account");
    const res = (await action({ request: form({ sid: SID, intent: "remove" }) } as never)) as Response;
    expect(res.headers.get("Location")).toBe("/login");
    expect(forgetRememberedAccount).toHaveBeenCalled();
    expect(activateRememberedAccount).not.toHaveBeenCalled();
  });
});
