import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/lib/dashboard/http.server", () => ({
  rateLimit: vi.fn().mockResolvedValue(true),
  clientIpKey: () => "k",
  checkSameOrigin: vi.fn(() => null),
  publicBaseUrl: () => "https://calderyncompany.com",
  wantsJson: (req: Request) => (req.headers.get("Accept") ?? "").includes("application/json"),
  jsonError: (s: number, e: string) => new Response(JSON.stringify({ error: e }), { status: s }),
}));
const getSessionFromRequest = vi.fn();
const getDashboardSessionAllowUnverified = vi.fn();
vi.mock("~/lib/dashboard/session.server", () => ({
  getSessionFromRequest,
  getDashboardSessionAllowUnverified,
}));
const setOnboardingProfile = vi.fn();
vi.mock("~/lib/auth/onboarding.server", () => ({
  setOnboardingProfile,
  normalizePhone: (r: string) => (r.replace(/\D/g, "").length >= 7 ? r.replace(/\D/g, "") : null),
  isReferralSource: (x: unknown) => x === "google_search" || x === "other",
  REFERRAL_SOURCES: ["google_search", "other"],
}));

function firstParty(over: Record<string, unknown> = {}) {
  return {
    shopId: "shop1",
    shopDomain: null,
    userId: "u1",
    sessionId: "s1",
    emailVerified: false,
    onboardedAt: null,
    ...over,
  };
}
function form(fields: Record<string, string>, json = true) {
  return new Request("https://app.x/dashboard/onboarding", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(json ? { Accept: "application/json" } : {}),
    },
    body: new URLSearchParams(fields).toString(),
  });
}
beforeEach(() => {
  getSessionFromRequest.mockReset();
  getDashboardSessionAllowUnverified.mockReset();
  setOnboardingProfile.mockReset().mockResolvedValue(undefined);
});

describe("onboarding loader", () => {
  it("redirects a signed-out visitor to /login", async () => {
    getSessionFromRequest.mockResolvedValue(null);
    const { loader } = await import("../dashboard.onboarding");
    const res = (await loader({ request: new Request("https://app.x/dashboard/onboarding") } as never)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login");
  });
  it("redirects an already-onboarded verified user to /dashboard", async () => {
    getSessionFromRequest.mockResolvedValue(firstParty({ onboardedAt: "2026-07-04T00:00:00Z", emailVerified: true }));
    const { loader } = await import("../dashboard.onboarding");
    const res = (await loader({ request: new Request("https://app.x/dashboard/onboarding") } as never)) as Response;
    expect(res.headers.get("Location")).toBe("/dashboard");
  });
  it("redirects a Shopify (userId null) session away", async () => {
    getSessionFromRequest.mockResolvedValue(firstParty({ userId: null, emailVerified: true }));
    const { loader } = await import("../dashboard.onboarding");
    const res = (await loader({ request: new Request("https://app.x/dashboard/onboarding") } as never)) as Response;
    expect(res.headers.get("Location")).toBe("/dashboard");
  });
  it("renders (returns data) for an un-onboarded first-party user", async () => {
    getSessionFromRequest.mockResolvedValue(firstParty());
    const { loader } = await import("../dashboard.onboarding");
    const data = await loader({ request: new Request("https://app.x/dashboard/onboarding?error=invalid_phone") } as never);
    expect(data).toMatchObject({ error: "invalid_phone" });
  });
});

describe("onboarding action", () => {
  it("422s an invalid phone", async () => {
    getSessionFromRequest.mockResolvedValue(firstParty());
    const { action } = await import("../dashboard.onboarding");
    const res = (await action({ request: form({ phone: "123", referral_source: "google_search" }) } as never)) as Response;
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "invalid_phone" });
  });
  it("422s an invalid referral", async () => {
    getSessionFromRequest.mockResolvedValue(firstParty());
    const { action } = await import("../dashboard.onboarding");
    const res = (await action({ request: form({ phone: "4155550123", referral_source: "myspace" }) } as never)) as Response;
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "invalid_referral" });
  });
  it("finish: saves and redirects an unverified user to verify-needed", async () => {
    getSessionFromRequest.mockResolvedValue(firstParty());
    const { action } = await import("../dashboard.onboarding");
    const res = (await action({ request: form({ phone: "4155550123", referral_source: "google_search" }, false) } as never)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/verify-needed");
    expect(setOnboardingProfile).toHaveBeenCalledWith("u1", expect.objectContaining({ phone: "4155550123", referralSource: "google_search" }));
  });
  it("finish: redirects a verified (Google) user to /dashboard", async () => {
    getSessionFromRequest.mockResolvedValue(firstParty({ emailVerified: true }));
    const { action } = await import("../dashboard.onboarding");
    const res = (await action({ request: form({ phone: "4155550123", referral_source: "google_search" }, false) } as never)) as Response;
    expect(res.headers.get("Location")).toBe("/dashboard");
  });
  it("connect: saves then hands off to the existing Shopify OAuth", async () => {
    getSessionFromRequest.mockResolvedValue(firstParty());
    const { action } = await import("../dashboard.onboarding");
    const res = (await action({ request: form({ intent: "connect", phone: "4155550123", referral_source: "google_search" }, false) } as never)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://calderyncompany.com/dashboard/login");
    expect(setOnboardingProfile).toHaveBeenCalled();
  });
  it("rejects a shop-based (userId null) session with 400 not_first_party", async () => {
    getSessionFromRequest.mockResolvedValue(firstParty({ userId: null }));
    const { action } = await import("../dashboard.onboarding");
    const res = (await action({ request: form({ phone: "4155550123", referral_source: "google_search" }) } as never)) as Response;
    expect(res.status).toBe(400);
  });

  it("redirects a browser form post to /login when the session is gone (no raw JSON in the tab)", async () => {
    getSessionFromRequest.mockResolvedValue(null);
    const { action } = await import("../dashboard.onboarding");
    const res = (await action({ request: form({ phone: "4155550123", referral_source: "google_search" }, false) } as never)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login");
  });

  it("returns 401 JSON to a JSON client when the session is gone", async () => {
    getSessionFromRequest.mockResolvedValue(null);
    const { action } = await import("../dashboard.onboarding");
    const res = (await action({ request: form({ phone: "4155550123", referral_source: "google_search" }, true) } as never)) as Response;
    expect(res.status).toBe(401);
  });

  it("forwards the 'other' free-text to setOnboardingProfile", async () => {
    getSessionFromRequest.mockResolvedValue(firstParty());
    const { action } = await import("../dashboard.onboarding");
    await action({ request: form({ phone: "4155550123", referral_source: "other", referral_source_other: "a friend at a meetup" }, false) } as never);
    expect(setOnboardingProfile).toHaveBeenCalledWith("u1", expect.objectContaining({ referralSource: "other", referralOther: "a friend at a meetup" }));
  });

  it("clamps referral_source_other to 120 chars at the action boundary", async () => {
    getSessionFromRequest.mockResolvedValue(firstParty());
    const { action } = await import("../dashboard.onboarding");
    const long = "x".repeat(300);
    await action({ request: form({ phone: "4155550123", referral_source: "other", referral_source_other: long }, false) } as never);
    const call = setOnboardingProfile.mock.calls[0][1] as { referralOther: string };
    expect(call.referralOther).toHaveLength(120);
  });
});
