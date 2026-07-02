import { describe, it, expect, beforeEach, vi } from "vitest";

// Hoisted mock handles shared by the Stripe SDK + Supabase mocks below.
const h = vi.hoisted(() => ({
  accountsCreate: vi.fn(),
  accountsRetrieve: vi.fn(),
  accountLinksCreate: vi.fn(),
  loginLinkCreate: vi.fn(),
  balanceRetrieve: vi.fn(),
  maybeSingle: vi.fn(),
  insert: vi.fn(),
  updateEq: vi.fn(),
}));

vi.mock("stripe", () => ({
  default: class {
    accounts = { create: h.accountsCreate, retrieve: h.accountsRetrieve, createLoginLink: h.loginLinkCreate };
    accountLinks = { create: h.accountLinksCreate };
    balance = { retrieve: h.balanceRetrieve };
  },
}));

// from("stripe_connected_account"): .select().eq().maybeSingle() reads; .insert() writes;
// .update(payload).eq() resolves via h.updateEq so tests can assert the payload.
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: h.maybeSingle }) }),
      insert: h.insert,
      update: (payload: Record<string, unknown>) => ({ eq: () => h.updateEq(payload) }),
    }),
  }),
}));

// eslint-disable-next-line import/first -- import must follow vi.mock so the fakes are registered before the module under test loads
import {
  computeApplicationFeeCents,
  destinationParamsFor,
  startOnboarding,
  syncAccountStatus,
  billingStatus,
} from "./connect.server";

const ROW = {
  shop_id: "shop-1",
  stripe_account_id: "acct_1",
  account_type: "express",
  charges_enabled: true,
  payouts_enabled: true,
  details_submitted: true,
  application_fee_bps: 0,
  application_fee_flat_cents: 0,
  country: "US",
  default_currency: "usd",
  onboarded_at: "2026-07-01T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  h.insert.mockResolvedValue({ error: null });
  h.updateEq.mockResolvedValue({ error: null });
});

describe("computeApplicationFeeCents", () => {
  it("computes bps + flat, rounded", () => {
    expect(computeApplicationFeeCents(10000, 250, 30)).toBe(280); // 2.5% + 30¢
    expect(computeApplicationFeeCents(999, 250, 0)).toBe(25); // round(24.975)
  });
  it("clamps to [0, amount]", () => {
    expect(computeApplicationFeeCents(100, 10000, 50)).toBe(100); // 100% + flat > amount
    expect(computeApplicationFeeCents(100, 0, 0)).toBe(0);
  });
});

describe("destinationParamsFor", () => {
  it("returns platform params when no connected account exists", async () => {
    h.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await destinationParamsFor("shop-1", 2500)).toEqual({
      params: {},
      stripeAccountId: null,
      applicationFeeCents: null,
    });
  });

  it.each([
    ["charges_enabled", { ...ROW, charges_enabled: false }],
    ["payouts_enabled", { ...ROW, payouts_enabled: false }],
    ["details_submitted", { ...ROW, details_submitted: false }],
  ])("returns platform params when %s is false (never route to a half-onboarded account)", async (_k, row) => {
    h.maybeSingle.mockResolvedValue({ data: row, error: null });
    expect((await destinationParamsFor("shop-1", 2500)).stripeAccountId).toBeNull();
  });

  it("routes with destination + on_behalf_of, OMITTING the fee param at fee 0 (pilot comp)", async () => {
    h.maybeSingle.mockResolvedValue({ data: ROW, error: null });
    expect(await destinationParamsFor("shop-1", 2500)).toEqual({
      params: { transfer_data: { destination: "acct_1" }, on_behalf_of: "acct_1" },
      stripeAccountId: "acct_1",
      applicationFeeCents: null, // null = no fee attached (spec §4)
    });
  });

  it("attaches application_fee_amount when the per-shop knob is set", async () => {
    h.maybeSingle.mockResolvedValue({
      data: { ...ROW, application_fee_bps: 250, application_fee_flat_cents: 30 },
      error: null,
    });
    const d = await destinationParamsFor("shop-1", 10000);
    expect(d.params.application_fee_amount).toBe(280);
    expect(d.applicationFeeCents).toBe(280);
  });
});

describe("startOnboarding", () => {
  it("creates an Express account (card_payments + transfers) + row on first call", async () => {
    h.maybeSingle.mockResolvedValue({ data: null, error: null });
    h.accountsCreate.mockResolvedValue({ id: "acct_new", country: "US", default_currency: "usd" });
    h.accountLinksCreate.mockResolvedValue({ url: "https://connect.stripe.com/setup/x" });

    const out = await startOnboarding("shop-1", "https://app.example.com");

    expect(h.accountsCreate).toHaveBeenCalledWith({
      type: "express",
      country: "US",
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      metadata: { shop_id: "shop-1" },
    });
    expect(h.insert).toHaveBeenCalledWith(
      expect.objectContaining({ shop_id: "shop-1", stripe_account_id: "acct_new", account_type: "express" }),
    );
    expect(h.accountLinksCreate).toHaveBeenCalledWith({
      account: "acct_new",
      type: "account_onboarding",
      return_url: "https://app.example.com/dashboard/payouts/stripe/return",
      refresh_url: "https://app.example.com/dashboard/payouts/stripe/refresh",
    });
    expect(out).toEqual({ url: "https://connect.stripe.com/setup/x" });
  });

  it("is idempotent: reuses the existing acct_ and only mints a fresh link", async () => {
    h.maybeSingle.mockResolvedValue({ data: ROW, error: null });
    h.accountLinksCreate.mockResolvedValue({ url: "https://connect.stripe.com/setup/y" });

    const out = await startOnboarding("shop-1", "https://app.example.com");

    expect(h.accountsCreate).not.toHaveBeenCalled();
    expect(h.insert).not.toHaveBeenCalled();
    expect(out).toEqual({ url: "https://connect.stripe.com/setup/y" });
  });
});

describe("syncAccountStatus", () => {
  it("returns null (no-op) when no connected account exists", async () => {
    h.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await syncAccountStatus("shop-1")).toBeNull();
    expect(h.accountsRetrieve).not.toHaveBeenCalled();
  });

  it("writes API-truth flags and stamps onboarded_at on first full enable", async () => {
    h.maybeSingle.mockResolvedValue({
      data: { ...ROW, charges_enabled: false, payouts_enabled: false, details_submitted: false, onboarded_at: null },
      error: null,
    });
    h.accountsRetrieve.mockResolvedValue({ charges_enabled: true, payouts_enabled: true, details_submitted: true });

    const out = await syncAccountStatus("shop-1");

    expect(out).toEqual({ chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true });
    const payload = h.updateEq.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toMatchObject({ charges_enabled: true, payouts_enabled: true, details_submitted: true });
    expect(payload.onboarded_at).toEqual(expect.any(String));
  });

  it("does NOT overwrite an existing onboarded_at", async () => {
    h.maybeSingle.mockResolvedValue({ data: ROW, error: null });
    h.accountsRetrieve.mockResolvedValue({ charges_enabled: true, payouts_enabled: true, details_submitted: true });
    await syncAccountStatus("shop-1");
    expect((h.updateEq.mock.calls[0][0] as Record<string, unknown>).onboarded_at).toBeUndefined();
  });
});

describe("billingStatus", () => {
  it("shapes the not-connected DTO", async () => {
    h.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await billingStatus("shop-1")).toEqual({
      connected: false,
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
      feeBps: 0,
      feeFlatCents: 0,
      balance: null,
      expressDashboardUrl: null,
    });
  });

  it("shapes the active DTO with live balance + Express login link", async () => {
    h.maybeSingle.mockResolvedValue({ data: ROW, error: null });
    h.balanceRetrieve.mockResolvedValue({
      available: [{ amount: 5000, currency: "usd" }],
      pending: [{ amount: 1200, currency: "usd" }],
    });
    h.loginLinkCreate.mockResolvedValue({ url: "https://connect.stripe.com/express/login" });

    expect(await billingStatus("shop-1")).toEqual({
      connected: true,
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
      feeBps: 0,
      feeFlatCents: 0,
      balance: {
        available: [{ amountCents: 5000, currency: "usd" }],
        pending: [{ amountCents: 1200, currency: "usd" }],
      },
      expressDashboardUrl: "https://connect.stripe.com/express/login",
    });
  });

  it("degrades to balance:null when the live Stripe read fails (status still renders)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.maybeSingle.mockResolvedValue({ data: ROW, error: null });
    h.balanceRetrieve.mockRejectedValue(new Error("stripe down"));
    h.loginLinkCreate.mockRejectedValue(new Error("stripe down"));

    const dto = await billingStatus("shop-1");
    expect(dto.connected).toBe(true);
    expect(dto.balance).toBeNull();
    expect(dto.expressDashboardUrl).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
