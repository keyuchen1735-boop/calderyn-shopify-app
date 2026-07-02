import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  requireDashboardSession: vi.fn(),
  syncAccountStatus: vi.fn(),
  startOnboarding: vi.fn(),
}));

vi.mock("~/lib/dashboard/session.server", () => ({ requireDashboardSession: h.requireDashboardSession }));
vi.mock("~/lib/payments/connect.server", () => ({
  syncAccountStatus: h.syncAccountStatus,
  startOnboarding: h.startOnboarding,
  onboardingOrigin: () => "https://app.example.com",
}));

// eslint-disable-next-line import/first -- import must follow vi.mock so the fakes are registered before the module under test loads
import { loader } from "../dashboard.payouts.stripe.$";

function call(leg: string) {
  return loader({
    request: new Request(`https://app.example.com/dashboard/payouts/stripe/${leg}`),
    params: { "*": leg },
    context: {},
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.requireDashboardSession.mockResolvedValue({ shopId: "shop-1" });
});

it("return: syncs status then redirects into the dashboard", async () => {
  h.syncAccountStatus.mockResolvedValue({ chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true });
  const res = await call("return");
  expect(h.syncAccountStatus).toHaveBeenCalledWith("shop-1");
  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).toBe("/dashboard?payouts=updated");
});

it("refresh: mints a fresh account link and redirects to Stripe", async () => {
  h.startOnboarding.mockResolvedValue({ url: "https://connect.stripe.com/setup/z" });
  const res = await call("refresh");
  expect(h.startOnboarding).toHaveBeenCalledWith("shop-1", "https://app.example.com");
  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).toBe("https://connect.stripe.com/setup/z");
});

it("404s any other leg", async () => {
  await expect(call("nope")).rejects.toMatchObject({ status: 404 });
});
