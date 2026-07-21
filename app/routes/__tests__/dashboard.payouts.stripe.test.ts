import { it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  requireVerifiedSession: vi.fn(),
  syncAccountStatus: vi.fn(),
  startOnboarding: vi.fn(),
  getConnectedAccount: vi.fn(),
}));

vi.mock("~/lib/dashboard/session.server", () => ({ requireVerifiedSession: h.requireVerifiedSession }));
vi.mock("~/lib/payments/connect.server", () => ({
  syncAccountStatus: h.syncAccountStatus,
  startOnboarding: h.startOnboarding,
  getConnectedAccount: h.getConnectedAccount,
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
  h.requireVerifiedSession.mockResolvedValue({ shopId: "shop-1" });
  h.getConnectedAccount.mockResolvedValue({ stripe_account_id: "acct_1" });
});

it("return: syncs status then redirects into the dashboard", async () => {
  h.syncAccountStatus.mockResolvedValue({ chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true });
  const res = await call("return");
  expect(h.syncAccountStatus).toHaveBeenCalledWith("shop-1");
  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).toBe("/dashboard/payments?payouts=updated");
});

it("refresh: mints a fresh account link and redirects to Stripe", async () => {
  h.startOnboarding.mockResolvedValue({ url: "https://connect.stripe.com/setup/z" });
  const res = await call("refresh");
  expect(h.startOnboarding).toHaveBeenCalledWith("shop-1", "https://app.example.com");
  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).toBe("https://connect.stripe.com/setup/z");
});

it("return: a transient sync failure still lands the merchant in the dashboard (warned, not error-paged)", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  h.syncAccountStatus.mockRejectedValue(new Error("stripe blip"));
  const res = await call("return");
  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).toBe("/dashboard/payments?payouts=updated");
  expect(warn).toHaveBeenCalledWith(expect.stringMatching(/return-leg status sync failed/));
  warn.mockRestore();
});

it("refresh: NEVER creates an account on GET — no connected row redirects to Payments", async () => {
  h.getConnectedAccount.mockResolvedValue(null);
  const res = await call("refresh");
  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).toBe("/dashboard/payments");
  expect(h.startOnboarding).not.toHaveBeenCalled();
});

it("404s any other leg", async () => {
  await expect(call("nope")).rejects.toMatchObject({ status: 404 });
});
