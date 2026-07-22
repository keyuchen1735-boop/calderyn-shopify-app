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
  shopsMaybeSingle: vi.fn(),
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

// Table-aware fake: from("stripe_connected_account") reads resolve via h.maybeSingle;
// from("shops") (the fresh demo_mode read on the money seam) via h.shopsMaybeSingle.
// .insert() writes; .update(payload).eq() resolves via h.updateEq so tests can assert
// the payload.
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({ maybeSingle: table === "shops" ? h.shopsMaybeSingle : h.maybeSingle }),
      }),
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
  paymentsReadiness,
  PaymentsNotReadyError,
  PayoutAccountError,
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

/** Stripe's rejection when an acct_ isn't owned by the platform key in use. */
const stripeUnknownAccountError = () =>
  Object.assign(
    new Error("You requested an account link for an account that is not connected to your platform or does not exist."),
    {
      type: "StripeInvalidRequestError",
      raw: {
        message:
          "You requested an account link for an account that is not connected to your platform or does not exist.",
      },
    },
  );

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  h.insert.mockResolvedValue({ error: null });
  h.updateEq.mockResolvedValue({ error: null });
  h.shopsMaybeSingle.mockResolvedValue({ data: { demo_mode: false }, error: null }); // default: real shop — fail closed
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

describe("paymentsReadiness", () => {
  it("is ready via destination for a fully-enabled connected account (demo lookup skipped)", async () => {
    h.maybeSingle.mockResolvedValue({ data: ROW, error: null });
    expect(await paymentsReadiness("shop-1")).toEqual({ ready: true, route: "destination", account: ROW });
    expect(h.shopsMaybeSingle).not.toHaveBeenCalled();
  });

  it("is ready via platform for a demo shop without a connected account", async () => {
    h.maybeSingle.mockResolvedValue({ data: null, error: null });
    h.shopsMaybeSingle.mockResolvedValue({ data: { demo_mode: true }, error: null });
    expect(await paymentsReadiness("shop-demo")).toEqual({ ready: true, route: "platform" });
  });

  it("fails closed for a demo shop when the platform key is live", async () => {
    process.env.STRIPE_SECRET_KEY = "rk_live_x";
    h.maybeSingle.mockResolvedValue({ data: null, error: null });
    h.shopsMaybeSingle.mockResolvedValue({ data: { demo_mode: true }, error: null });
    expect(await paymentsReadiness("shop-demo")).toEqual({ ready: false, reason: "no_account" });
  });

  it("is not ready (no_account) for a real shop with no connected account", async () => {
    h.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await paymentsReadiness("shop-1")).toEqual({ ready: false, reason: "no_account" });
  });

  it("is not ready (onboarding_incomplete) for a half-onboarded real shop", async () => {
    h.maybeSingle.mockResolvedValue({ data: { ...ROW, payouts_enabled: false }, error: null });
    expect(await paymentsReadiness("shop-1")).toEqual({ ready: false, reason: "onboarding_incomplete" });
  });

  it("fails toward NOT ready (real shop) when the fresh demo_mode read errors", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    h.maybeSingle.mockResolvedValue({ data: null, error: null });
    h.shopsMaybeSingle.mockResolvedValue({ data: null, error: { message: "db blip" } });
    expect(await paymentsReadiness("shop-1")).toEqual({ ready: false, reason: "no_account" });
    spy.mockRestore();
  });
});

describe("destinationParamsFor", () => {
  it("fails CLOSED (PaymentsNotReadyError) when a real shop has no connected account", async () => {
    h.maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(destinationParamsFor("shop-1", 2500)).rejects.toBeInstanceOf(PaymentsNotReadyError);
  });

  it.each([
    ["charges_enabled", { ...ROW, charges_enabled: false }],
    ["payouts_enabled", { ...ROW, payouts_enabled: false }],
    ["details_submitted", { ...ROW, details_submitted: false }],
  ])("fails CLOSED when %s is false (never route to a half-onboarded account)", async (_k, row) => {
    h.maybeSingle.mockResolvedValue({ data: row, error: null });
    await expect(destinationParamsFor("shop-1", 2500)).rejects.toBeInstanceOf(PaymentsNotReadyError);
  });

  it("returns platform params for a DEMO shop (the single platform-charge exemption)", async () => {
    h.maybeSingle.mockResolvedValue({ data: null, error: null });
    h.shopsMaybeSingle.mockResolvedValue({ data: { demo_mode: true }, error: null });
    expect(await destinationParamsFor("shop-demo", 2500)).toEqual({
      params: {},
      stripeAccountId: null,
      applicationFeeCents: null,
    });
  });

  it("reuses a caller-supplied readiness decision without a second account read", async () => {
    const d = await destinationParamsFor("shop-1", 2500, { ready: true, route: "destination", account: ROW });
    expect(d.stripeAccountId).toBe("acct_1");
    expect(h.maybeSingle).not.toHaveBeenCalled();
    expect(h.shopsMaybeSingle).not.toHaveBeenCalled();
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

  it("propagates a connected-account read error — a charge is never routed on unknown state", async () => {
    h.maybeSingle.mockResolvedValue({ data: null, error: { message: "relation missing" } });
    await expect(destinationParamsFor("shop-1", 2500)).rejects.toMatchObject({ message: "relation missing" });
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

  it("platform path (demo shop only): no connected account -> create(base) verbatim, null stamps", async () => {
    h.maybeSingle.mockResolvedValue({ data: null, error: null });
    h.shopsMaybeSingle.mockResolvedValue({ data: { demo_mode: true }, error: null });
    h.piCreate.mockResolvedValue({ id: "pi_1", status: "requires_payment_method" });

    const out = await createRoutedPaymentIntent("shop-1", BASE);

    expect(h.piCreate).toHaveBeenCalledTimes(1);
    expect(h.piCreate).toHaveBeenCalledWith(BASE);
    expect(out).toMatchObject({ stripeAccountId: null, applicationFeeCents: null });
    expect(out.pi.id).toBe("pi_1");
  });

  it("fails CLOSED before any Stripe call when a real shop is not payment-ready", async () => {
    h.maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(createRoutedPaymentIntent("shop-1", BASE)).rejects.toBeInstanceOf(PaymentsNotReadyError);
    expect(h.piCreate).not.toHaveBeenCalled();
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

  it("fails CLOSED (never a platform retry) on a destination-param invalid-request, re-syncing stale flags", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.maybeSingle.mockResolvedValue({ data: ROW, error: null });
    h.accountsRetrieve.mockResolvedValue({ charges_enabled: false, payouts_enabled: false, details_submitted: true });
    h.piCreate.mockRejectedValueOnce(destinationErr());

    await expect(createRoutedPaymentIntent("shop-1", BASE)).rejects.toBeInstanceOf(PaymentsNotReadyError);

    // Exactly one create attempt — buyer money is NEVER re-routed into the platform account.
    expect(h.piCreate).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/failing closed/));
    // The stale row is re-synced (fire-and-forget) so the next load shows the honest state.
    await vi.waitFor(() => expect(h.accountsRetrieve).toHaveBeenCalledWith("acct_1"));
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

  it("re-provisions when the stored acct_ is unknown to the platform and was never onboarded", async () => {
    // The row points at an account this platform key doesn't own (key rotated /
    // mode switched / account deleted in Stripe): the stored id can never mint a
    // link again, so onboarding is bricked until the row is replaced.
    h.maybeSingle.mockResolvedValue({
      data: { ...ROW, charges_enabled: false, payouts_enabled: false, details_submitted: false, onboarded_at: null },
      error: null,
    });
    h.accountLinksCreate
      .mockRejectedValueOnce(stripeUnknownAccountError())
      .mockResolvedValueOnce({ url: "https://connect.stripe.com/setup/fresh" });
    h.accountsCreate.mockResolvedValue({ id: "acct_fresh", country: "US", default_currency: "usd" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const out = await startOnboarding("shop-1", "https://app.example.com");

    expect(out).toEqual({ url: "https://connect.stripe.com/setup/fresh" });
    expect(h.accountsCreate).toHaveBeenCalledTimes(1);
    // The dead id is replaced in place (unique shop_id — an insert would fail),
    // with every status flag reset so nothing inherits the old account's state.
    expect(h.updateEq).toHaveBeenCalledWith(
      expect.objectContaining({
        stripe_account_id: "acct_fresh",
        charges_enabled: false,
        payouts_enabled: false,
        details_submitted: false,
        onboarded_at: null,
      }),
    );
    expect(h.insert).not.toHaveBeenCalled();
    expect(h.accountLinksCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({ account: "acct_fresh", type: "account_onboarding" }),
    );
    warn.mockRestore();
  });

  it("refuses to re-provision an ONBOARDED account the platform no longer recognizes", async () => {
    // Money-adjacent: a fully-onboarded account going unknown means the platform
    // key is misconfigured, not that the row is stale. Minting a replacement here
    // would strand the merchant's real payout account.
    h.maybeSingle.mockResolvedValue({ data: ROW, error: null });
    // Reset (not just clear): the re-provision case above queues `...Once`
    // outcomes, and a leftover one would decide this test instead of the code.
    h.accountLinksCreate.mockReset();
    h.accountLinksCreate.mockRejectedValue(stripeUnknownAccountError());
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(startOnboarding("shop-1", "https://app.example.com")).rejects.toBeInstanceOf(PayoutAccountError);
    expect(h.accountsCreate).not.toHaveBeenCalled();
    expect(h.updateEq).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("surfaces any other Stripe failure with its own message (never an opaque 500)", async () => {
    h.maybeSingle.mockResolvedValue({ data: ROW, error: null });
    h.accountLinksCreate.mockRejectedValue(
      Object.assign(new Error("Stripe is temporarily unavailable"), { type: "StripeAPIError" }),
    );

    await expect(startOnboarding("shop-1", "https://app.example.com")).rejects.toThrow(
      /Stripe is temporarily unavailable/,
    );
    expect(h.accountsCreate).not.toHaveBeenCalled();
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

  it("reports an unknown-to-the-platform account as a payout error, and never writes flags", async () => {
    // Same orphaned-row cause as startOnboarding's re-provision path. Status sync
    // must NOT create accounts, so it explains the state instead of 500ing.
    h.maybeSingle.mockResolvedValue({ data: { ...ROW, onboarded_at: null }, error: null });
    h.accountsRetrieve.mockRejectedValue(stripeUnknownAccountError());

    await expect(syncAccountStatus("shop-1")).rejects.toBeInstanceOf(PayoutAccountError);
    expect(h.updateEq).not.toHaveBeenCalled();
    expect(h.accountsCreate).not.toHaveBeenCalled();
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
