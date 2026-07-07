import { describe, it, expect, beforeEach, vi } from "vitest";

// Hoisted mock handles shared by the Stripe SDK + Supabase mocks below.
const h = vi.hoisted(() => ({
  accountsCreate: vi.fn(),
  accountsRetrieve: vi.fn(),
  accountLinksCreate: vi.fn(),
  loginLinkCreate: vi.fn(),
  balanceRetrieve: vi.fn(),
  piCreate: vi.fn(),
  maybeSingle: vi.fn(),
  insert: vi.fn(),
  updateEq: vi.fn(),
}));

vi.mock("stripe", () => ({
  default: class {
    accounts = { create: h.accountsCreate, retrieve: h.accountsRetrieve, createLoginLink: h.loginLinkCreate };
    accountLinks = { create: h.accountLinksCreate };
    balance = { retrieve: h.balanceRetrieve };
    paymentIntents = { create: h.piCreate };
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
  createRoutedPaymentIntent,
  destinationParamsFor,
  expressLoginLink,
  startOnboarding,
  syncAccountStatus,
  applyAccountUpdate,
  billingStatus,
} from "./connect.server";
// eslint-disable-next-line import/first -- follows vi.mock like the import above; type-only, erased at build
import type Stripe from "stripe";

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

  it("fails OPEN to a platform charge when the connected-account read errors (spec §7)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.maybeSingle.mockResolvedValue({ data: null, error: { message: "relation missing" } });
    expect(await destinationParamsFor("shop-1", 2500)).toEqual({
      params: {},
      stripeAccountId: null,
      applicationFeeCents: null,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/lookup failed .* using platform charge/));
    warn.mockRestore();
  });
});

describe("createRoutedPaymentIntent", () => {
  const BASE = {
    amount: 2500,
    currency: "usd",
    metadata: { shop_id: "shop-1", order_ref: "order-1" },
  };
  const destinationErr = (over: Record<string, unknown> = {}) =>
    Object.assign(new Error("No such destination: 'acct_1'"), {
      type: "StripeInvalidRequestError",
      code: "resource_missing",
      param: "transfer_data[destination]",
      ...over,
    });

  it("platform path: no connected account -> create(base) verbatim, null stamps", async () => {
    h.maybeSingle.mockResolvedValue({ data: null, error: null });
    h.piCreate.mockResolvedValue({ id: "pi_1", status: "requires_payment_method" });

    const out = await createRoutedPaymentIntent("shop-1", BASE);

    expect(h.piCreate).toHaveBeenCalledTimes(1);
    expect(h.piCreate).toHaveBeenCalledWith(BASE);
    expect(out).toMatchObject({ stripeAccountId: null, applicationFeeCents: null });
    expect(out.pi.id).toBe("pi_1");
  });

  it("routed path: spreads destination params and returns the routed stamps", async () => {
    h.maybeSingle.mockResolvedValue({
      data: { ...ROW, application_fee_bps: 250, application_fee_flat_cents: 30 },
      error: null,
    });
    h.piCreate.mockResolvedValue({ id: "pi_2", status: "requires_payment_method" });

    const out = await createRoutedPaymentIntent("shop-1", { ...BASE, amount: 10000 });

    expect(h.piCreate).toHaveBeenCalledWith({
      ...BASE,
      amount: 10000,
      transfer_data: { destination: "acct_1" },
      on_behalf_of: "acct_1",
      application_fee_amount: 280,
    });
    expect(out).toMatchObject({ stripeAccountId: "acct_1", applicationFeeCents: 280 });
  });

  it("falls back to a platform charge ONLY on a destination-param invalid-request (narrow guard)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.maybeSingle.mockResolvedValue({ data: ROW, error: null });
    h.accountsRetrieve.mockResolvedValue({ charges_enabled: false, payouts_enabled: false, details_submitted: true });
    h.piCreate
      .mockRejectedValueOnce(destinationErr())
      .mockResolvedValueOnce({ id: "pi_fb", status: "requires_payment_method" });

    const out = await createRoutedPaymentIntent("shop-1", BASE);

    expect(h.piCreate).toHaveBeenCalledTimes(2);
    expect(h.piCreate.mock.calls[1][0]).toEqual(BASE); // second attempt: NO connect params
    expect(out).toMatchObject({ stripeAccountId: null, applicationFeeCents: null });
    expect(out.pi.id).toBe("pi_fb");
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/falling back to platform charge/));
    warn.mockRestore();
  });

  it("an invalid-request WE caused (non-destination param) propagates — never silently converted (rule 12)", async () => {
    h.maybeSingle.mockResolvedValue({ data: ROW, error: null });
    h.piCreate.mockRejectedValue(
      Object.assign(new Error("Amount must be at least 50 cents"), {
        type: "StripeInvalidRequestError",
        code: "amount_too_small",
        param: "amount",
      }),
    );
    await expect(createRoutedPaymentIntent("shop-1", BASE)).rejects.toThrow(/50 cents/);
    expect(h.piCreate).toHaveBeenCalledTimes(1);
  });

  it("a card DECLINE is NEVER retried — a confirm:true create cannot double-attempt the buyer", async () => {
    h.maybeSingle.mockResolvedValue({ data: ROW, error: null });
    h.piCreate.mockRejectedValue(Object.assign(new Error("card declined"), { type: "StripeCardError" }));
    await expect(
      createRoutedPaymentIntent("shop-1", { ...BASE, payment_method: "spt_1", confirm: true }),
    ).rejects.toThrow(/card declined/);
    expect(h.piCreate).toHaveBeenCalledTimes(1);
  });

  it("non-Stripe-request errors (rate limit, network) propagate without retry", async () => {
    h.maybeSingle.mockResolvedValue({ data: ROW, error: null });
    h.piCreate.mockRejectedValue(Object.assign(new Error("rate limited"), { type: "StripeRateLimitError" }));
    await expect(createRoutedPaymentIntent("shop-1", BASE)).rejects.toThrow(/rate limited/);
    expect(h.piCreate).toHaveBeenCalledTimes(1);
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

describe("applyAccountUpdate (account.updated webhook re-sync)", () => {
  const evtAccount = (over: Partial<Stripe.Account> = {}) =>
    ({ id: "acct_1", charges_enabled: true, payouts_enabled: true, details_submitted: true, ...over }) as Stripe.Account;

  it("writes the event's flags and stamps onboarded_at on the async-enable transition", async () => {
    // The stored row is still pending (charges not yet enabled, onboarded_at null); the account was
    // enabled asynchronously and Stripe delivered account.updated with the now-live flags.
    h.maybeSingle.mockResolvedValue({ data: { shop_id: "shop-1", onboarded_at: null }, error: null });

    const applied = await applyAccountUpdate(evtAccount());

    expect(applied).toBe(true);
    const payload = h.updateEq.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toMatchObject({ charges_enabled: true, payouts_enabled: true, details_submitted: true });
    expect(payload.onboarded_at).toEqual(expect.any(String)); // stamped on first full enable
  });

  it("returns false and writes nothing when the account is not linked to any shop", async () => {
    h.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await applyAccountUpdate(evtAccount())).toBe(false);
    expect(h.updateEq).not.toHaveBeenCalled();
  });

  it("does not stamp onboarded_at when the account is only partially enabled", async () => {
    h.maybeSingle.mockResolvedValue({ data: { shop_id: "shop-1", onboarded_at: null }, error: null });
    await applyAccountUpdate(evtAccount({ payouts_enabled: false }));
    expect((h.updateEq.mock.calls[0][0] as Record<string, unknown>).onboarded_at).toBeUndefined();
  });

  it("does not overwrite an existing onboarded_at on a later account.updated", async () => {
    h.maybeSingle.mockResolvedValue({ data: { shop_id: "shop-1", onboarded_at: "2026-07-01T00:00:00.000Z" }, error: null });
    await applyAccountUpdate(evtAccount());
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
    });
  });

  it("shapes the active DTO with the live balance (login links are minted on demand, not here)", async () => {
    h.maybeSingle.mockResolvedValue({ data: ROW, error: null });
    h.balanceRetrieve.mockResolvedValue({
      available: [{ amount: 5000, currency: "usd" }],
      pending: [{ amount: 1200, currency: "usd" }],
    });

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
    });
    expect(h.loginLinkCreate).not.toHaveBeenCalled(); // no per-load single-use link waste
  });

  it("degrades to balance:null when the live Stripe read fails (status still renders)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.maybeSingle.mockResolvedValue({ data: ROW, error: null });
    h.balanceRetrieve.mockRejectedValue(new Error("stripe down"));

    const dto = await billingStatus("shop-1");
    expect(dto.connected).toBe(true);
    expect(dto.balance).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("expressLoginLink", () => {
  it("returns null when there is no fully-submitted connected account", async () => {
    h.maybeSingle.mockResolvedValue({ data: { ...ROW, details_submitted: false }, error: null });
    expect(await expressLoginLink("shop-1")).toBeNull();
    expect(h.loginLinkCreate).not.toHaveBeenCalled();
  });

  it("mints a single-use login link for an onboarded account", async () => {
    h.maybeSingle.mockResolvedValue({ data: ROW, error: null });
    h.loginLinkCreate.mockResolvedValue({ url: "https://connect.stripe.com/express/login" });
    expect(await expressLoginLink("shop-1")).toEqual({ url: "https://connect.stripe.com/express/login" });
    expect(h.loginLinkCreate).toHaveBeenCalledWith("acct_1");
  });
});
