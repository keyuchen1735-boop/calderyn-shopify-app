import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

const renderFixture = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));
vi.mock("@remix-run/react", () => ({
  useLoaderData: () => renderFixture.data,
}));

vi.mock("~/lib/dashboard/http.server", () => ({
  rateLimit: vi.fn().mockResolvedValue(true),
  clientIpKey: () => "k",
  checkSameOrigin: vi.fn(() => null),
  publicBaseUrl: () => "https://calderyncompany.com",
  wantsJson: (req: Request) => (req.headers.get("Accept") ?? "").includes("application/json"),
  jsonError: (s: number, e: string) => new Response(JSON.stringify({ error: e }), { status: s }),
  // Mirror the real guard: only same-origin /dashboard paths pass, else null.
  safeDashboardReturnTo: (v: unknown) => (typeof v === "string" && v.startsWith("/dashboard") ? v : null),
}));
const getSessionFromRequest = vi.fn();
vi.mock("~/lib/dashboard/session.server", () => ({
  getSessionFromRequest,
}));
const saveOnboardingContact = vi.fn();
const completeOnboarding = vi.fn();
const getOnboardingProgress = vi.fn();
vi.mock("~/lib/auth/onboarding.server", () => ({
  saveOnboardingContact,
  completeOnboarding,
  getOnboardingProgress,
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
  saveOnboardingContact.mockReset().mockResolvedValue(undefined);
  completeOnboarding.mockReset().mockResolvedValue(undefined);
  // Default: contact not yet saved (step 1). Step-2 tests override this.
  getOnboardingProgress.mockReset().mockResolvedValue({ phone: null });
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
  it("shows the contact step for an un-onboarded user with no phone saved yet", async () => {
    getSessionFromRequest.mockResolvedValue(firstParty());
    getOnboardingProgress.mockResolvedValue({ phone: null });
    const { loader } = await import("../dashboard.onboarding");
    const data = await loader({ request: new Request("https://app.x/dashboard/onboarding?error=invalid_phone") } as never);
    expect(data).toMatchObject({ step: "contact", error: "invalid_phone" });
  });
  it("shows the import step once contact (phone) is saved but onboarding is not complete", async () => {
    getSessionFromRequest.mockResolvedValue(firstParty());
    getOnboardingProgress.mockResolvedValue({ phone: "4155550123" });
    const { loader } = await import("../dashboard.onboarding");
    const data = await loader({ request: new Request("https://app.x/dashboard/onboarding") } as never);
    expect(data).toMatchObject({ step: "import" });
  });
  it("surfaces a validated return_to for the view to carry through", async () => {
    getSessionFromRequest.mockResolvedValue(firstParty());
    const { loader } = await import("../dashboard.onboarding");
    const data = await loader({
      request: new Request("https://app.x/dashboard/onboarding?return_to=" + encodeURIComponent("/dashboard/connect?t=abc")),
    } as never);
    expect(data).toMatchObject({ returnTo: "/dashboard/connect?t=abc" });
  });
  it("drops an unsafe return_to", async () => {
    getSessionFromRequest.mockResolvedValue(firstParty());
    const { loader } = await import("../dashboard.onboarding");
    const data = await loader({
      request: new Request("https://app.x/dashboard/onboarding?return_to=" + encodeURIComponent("https://evil.example/phish")),
    } as never);
    expect(data).toMatchObject({ returnTo: null });
  });
});

describe("onboarding action — contact step", () => {
  it("422s an invalid phone", async () => {
    getSessionFromRequest.mockResolvedValue(firstParty());
    const { action } = await import("../dashboard.onboarding");
    const res = (await action({ request: form({ intent: "contact", phone: "123", referral_source: "google_search" }) } as never)) as Response;
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "invalid_phone" });
  });
  it("422s an invalid referral", async () => {
    getSessionFromRequest.mockResolvedValue(firstParty());
    const { action } = await import("../dashboard.onboarding");
    const res = (await action({ request: form({ intent: "contact", phone: "4155550123", referral_source: "myspace" }) } as never)) as Response;
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "invalid_referral" });
  });
  it("saves contact WITHOUT completing, then advances to the import step", async () => {
    getSessionFromRequest.mockResolvedValue(firstParty());
    const { action } = await import("../dashboard.onboarding");
    const res = (await action({ request: form({ intent: "contact", phone: "4155550123", referral_source: "google_search" }, false) } as never)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/onboarding");
    expect(saveOnboardingContact).toHaveBeenCalledWith("u1", expect.objectContaining({ phone: "4155550123", referralSource: "google_search" }));
    // Completion is deferred to the import step — the gate must still hold.
    expect(completeOnboarding).not.toHaveBeenCalled();
  });
  it("carries a validated return_to through the step-1 → step-2 hop", async () => {
    getSessionFromRequest.mockResolvedValue(firstParty());
    const { action } = await import("../dashboard.onboarding");
    const res = (await action({ request: form({ intent: "contact", phone: "4155550123", referral_source: "google_search", return_to: "/dashboard/connect?t=abc" }, false) } as never)) as Response;
    expect(res.headers.get("Location")).toBe("/dashboard/onboarding?return_to=" + encodeURIComponent("/dashboard/connect?t=abc"));
  });
  it("preserves the threaded return_to on a validation error so the flow can resume", async () => {
    getSessionFromRequest.mockResolvedValue(firstParty());
    const { action } = await import("../dashboard.onboarding");
    const res = (await action({ request: form({ intent: "contact", phone: "123", referral_source: "google_search", return_to: "/dashboard/connect?t=abc" }, false) } as never)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/onboarding?error=invalid_phone&return_to=" + encodeURIComponent("/dashboard/connect?t=abc"));
  });
  it("forwards the 'other' free-text to saveOnboardingContact", async () => {
    getSessionFromRequest.mockResolvedValue(firstParty());
    const { action } = await import("../dashboard.onboarding");
    await action({ request: form({ intent: "contact", phone: "4155550123", referral_source: "other", referral_source_other: "a friend at a meetup" }, false) } as never);
    expect(saveOnboardingContact).toHaveBeenCalledWith("u1", expect.objectContaining({ referralSource: "other", referralOther: "a friend at a meetup" }));
  });
  it("clamps referral_source_other to 120 chars at the action boundary", async () => {
    getSessionFromRequest.mockResolvedValue(firstParty());
    const { action } = await import("../dashboard.onboarding");
    const long = "x".repeat(300);
    await action({ request: form({ intent: "contact", phone: "4155550123", referral_source: "other", referral_source_other: long }, false) } as never);
    const call = saveOnboardingContact.mock.calls[0][1] as { referralOther: string };
    expect(call.referralOther).toHaveLength(120);
  });

  it("fails visibly on a POST with no recognized intent (never a silent contact submit)", async () => {
    getSessionFromRequest.mockResolvedValue(firstParty());
    const { action } = await import("../dashboard.onboarding");
    const res = (await action({ request: form({}, true) } as never)) as Response;
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_intent" });
    expect(saveOnboardingContact).not.toHaveBeenCalled();
    expect(completeOnboarding).not.toHaveBeenCalled();
  });
});

describe("onboarding action — import step", () => {
  it("skip: completes onboarding and redirects an unverified user to verify-needed", async () => {
    getSessionFromRequest.mockResolvedValue(firstParty());
    getOnboardingProgress.mockResolvedValue({ phone: "4155550123" });
    const { action } = await import("../dashboard.onboarding");
    const res = (await action({ request: form({ intent: "skip" }, false) } as never)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/verify-needed");
    expect(completeOnboarding).toHaveBeenCalledWith("u1");
  });
  it("skip: completes onboarding and redirects a verified (Google) user to /dashboard", async () => {
    getSessionFromRequest.mockResolvedValue(firstParty({ emailVerified: true }));
    getOnboardingProgress.mockResolvedValue({ phone: "4155550123" });
    const { action } = await import("../dashboard.onboarding");
    const res = (await action({ request: form({ intent: "skip" }, false) } as never)) as Response;
    expect(res.headers.get("Location")).toBe("/dashboard");
    expect(completeOnboarding).toHaveBeenCalledWith("u1");
  });
  it("connect: completes onboarding then hands off to the existing Shopify OAuth", async () => {
    getSessionFromRequest.mockResolvedValue(firstParty());
    getOnboardingProgress.mockResolvedValue({ phone: "4155550123" });
    const { action } = await import("../dashboard.onboarding");
    const res = (await action({ request: form({ intent: "connect" }, false) } as never)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://calderyncompany.com/dashboard/login");
    expect(completeOnboarding).toHaveBeenCalledWith("u1");
  });
  it("refuses to complete the import step when contact was never saved (no half-filled profile)", async () => {
    getSessionFromRequest.mockResolvedValue(firstParty());
    getOnboardingProgress.mockResolvedValue({ phone: null });
    const { action } = await import("../dashboard.onboarding");
    const res = (await action({ request: form({ intent: "skip" }, false) } as never)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/onboarding");
    expect(completeOnboarding).not.toHaveBeenCalled();
  });
  it("returns 400 contact_required to a JSON client that skips before saving contact", async () => {
    getSessionFromRequest.mockResolvedValue(firstParty());
    getOnboardingProgress.mockResolvedValue({ phone: null });
    const { action } = await import("../dashboard.onboarding");
    const res = (await action({ request: form({ intent: "skip" }, true) } as never)) as Response;
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "contact_required" });
    expect(completeOnboarding).not.toHaveBeenCalled();
  });
  it("skip: resumes a threaded return_to instead of the default target", async () => {
    getSessionFromRequest.mockResolvedValue(firstParty({ emailVerified: true }));
    getOnboardingProgress.mockResolvedValue({ phone: "4155550123" });
    const { action } = await import("../dashboard.onboarding");
    const res = (await action({ request: form({ intent: "skip", return_to: "/dashboard/connect?t=abc" }, false) } as never)) as Response;
    expect(res.headers.get("Location")).toBe("/dashboard/connect?t=abc");
    expect(completeOnboarding).toHaveBeenCalledWith("u1");
  });
});

describe("onboarding action — session guards", () => {
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
  it("redirects an already-onboarded user's replayed POST away without mutating anything", async () => {
    getSessionFromRequest.mockResolvedValue(firstParty({ onboardedAt: "2026-07-04T00:00:00Z", emailVerified: true }));
    const { action } = await import("../dashboard.onboarding");
    const res = (await action({ request: form({ phone: "4155550123", referral_source: "google_search" }, false) } as never)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard");
    expect(saveOnboardingContact).not.toHaveBeenCalled();
    expect(completeOnboarding).not.toHaveBeenCalled();
  });
  it("returns 409 already_onboarded to a JSON client replaying after completion", async () => {
    getSessionFromRequest.mockResolvedValue(firstParty({ onboardedAt: "2026-07-04T00:00:00Z", emailVerified: true }));
    const { action } = await import("../dashboard.onboarding");
    const res = (await action({ request: form({ intent: "skip" }, true) } as never)) as Response;
    expect(res.status).toBe(409);
    expect(completeOnboarding).not.toHaveBeenCalled();
  });
});

describe("onboarding render", () => {
  async function render(data: Record<string, unknown>): Promise<string> {
    renderFixture.data = data;
    const Onboarding = (await import("../dashboard.onboarding")).default;
    return renderToString(createElement(Onboarding));
  }

  it("contact step renders phone + how-heard and posts the contact intent", async () => {
    const html = await render({ step: "contact", error: null, returnTo: null });
    expect(html).toContain('name="phone"');
    expect(html).toContain('name="referral_source"');
    expect(html).toContain("hear about us");
    expect(html).toContain('value="contact"');
    // No return_to in flight ⇒ no hidden field.
    expect(html).not.toContain('name="return_to"');
  });

  it("import step carries connect + skip as hidden intent fields, not submit-button values", async () => {
    const html = await render({ step: "import", error: null, returnTo: null });
    expect(html).toContain("Bring your store over");
    // The intent must ride a hidden input: a submit button's own name/value is
    // an unreliable carrier and was silently dropped in production, so the
    // action mis-read the click as a contact submit and bounced back here.
    expect(html).toContain('type="hidden" name="intent" value="connect"');
    expect(html).toContain('type="hidden" name="intent" value="skip"');
    expect(html).toContain("Connect Shopify");
    expect(html).toContain("Skip for now");
  });

  it("threads a return_to into the step form as a hidden field so it survives submit", async () => {
    const html = await render({ step: "import", error: null, returnTo: "/dashboard/connect?t=abc" });
    expect(html).toContain('name="return_to"');
    expect(html).toContain("/dashboard/connect?t=abc");
  });
});
