import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  requireDashboardSession: vi.fn(),
  billingStatus: vi.fn(),
  startOnboarding: vi.fn(),
  syncAccountStatus: vi.fn(),
  expressLoginLink: vi.fn(),
}));

vi.mock("~/lib/dashboard/session.server", () => ({ requireDashboardSession: h.requireDashboardSession }));
vi.mock("~/lib/payments/connect.server", () => ({
  billingStatus: h.billingStatus,
  startOnboarding: h.startOnboarding,
  syncAccountStatus: h.syncAccountStatus,
  expressLoginLink: h.expressLoginLink,
  onboardingOrigin: () => "https://app.example.com",
}));

// eslint-disable-next-line import/first -- import must follow vi.mock so the fakes are registered before the module under test loads
import { loader, action } from "../dashboard.api.billing";

const DTO = {
  connected: false,
  chargesEnabled: false,
  payoutsEnabled: false,
  detailsSubmitted: false,
  feeBps: 0,
  feeFlatCents: 0,
  balance: null,
};

function post(body: unknown) {
  return new Request("https://app.example.com/dashboard/api/billing", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://app.example.com" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SHOPIFY_APP_URL = "https://app.example.com";
  h.requireDashboardSession.mockResolvedValue({ shopId: "shop-1" });
  h.billingStatus.mockResolvedValue(DTO);
});

describe("loader", () => {
  it("returns the billing DTO for the session's shop", async () => {
    const res = await loader({
      request: new Request("https://app.example.com/dashboard/api/billing"),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(DTO);
    expect(h.billingStatus).toHaveBeenCalledWith("shop-1");
  });
});

describe("action", () => {
  it("start-onboarding returns the hosted-onboarding url", async () => {
    h.startOnboarding.mockResolvedValue({ url: "https://connect.stripe.com/setup/x" });
    const res = await action({ request: post({ intent: "start-onboarding" }), params: {}, context: {} } as never);
    expect(await res.json()).toEqual({ url: "https://connect.stripe.com/setup/x" });
    expect(h.startOnboarding).toHaveBeenCalledWith("shop-1", "https://app.example.com");
  });

  it("refresh-status syncs then returns a fresh DTO", async () => {
    h.syncAccountStatus.mockResolvedValue({ chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true });
    const res = await action({ request: post({ intent: "refresh-status" }), params: {}, context: {} } as never);
    expect(h.syncAccountStatus).toHaveBeenCalledWith("shop-1");
    expect(await res.json()).toEqual(DTO);
  });

  it("login-link mints an on-demand Express login link", async () => {
    h.expressLoginLink.mockResolvedValue({ url: "https://connect.stripe.com/express/login" });
    const res = await action({ request: post({ intent: "login-link" }), params: {}, context: {} } as never);
    expect(await res.json()).toEqual({ url: "https://connect.stripe.com/express/login" });
    expect(h.expressLoginLink).toHaveBeenCalledWith("shop-1");
  });

  it("login-link returns 409 when the account is not onboarded", async () => {
    h.expressLoginLink.mockResolvedValue(null);
    const res = await action({ request: post({ intent: "login-link" }), params: {}, context: {} } as never);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "not_onboarded" });
  });

  it("rejects an unknown intent with 422", async () => {
    const res = await action({ request: post({ intent: "nope" }), params: {}, context: {} } as never);
    expect(res.status).toBe(422);
  });

  it("rejects non-POST with 405", async () => {
    const req = new Request("https://app.example.com/dashboard/api/billing", {
      method: "PUT",
      headers: { Origin: "https://app.example.com" },
    });
    const res = await action({ request: req, params: {}, context: {} } as never);
    expect(res.status).toBe(405);
  });

  it("rejects malformed JSON with 422", async () => {
    const req = new Request("https://app.example.com/dashboard/api/billing", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://app.example.com" },
      body: "{nope",
    });
    const res = await action({ request: req, params: {}, context: {} } as never);
    expect(res.status).toBe(422);
  });
});
