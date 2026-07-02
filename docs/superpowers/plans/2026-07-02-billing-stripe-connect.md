# #11 Billing — Stripe Connect Payouts + Platform Fee — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route buyer payments to per-merchant Stripe Express connected accounts (destination charges, auto payouts) with a per-shop application fee (default 0 = pilot comp), per `docs/superpowers/specs/2026-07-02-billing-stripe-connect-design.md`.

**Architecture:** All Connect logic lives in one new server module (`connect.server.ts`) whose `destinationParamsFor` decision is spread into BOTH PaymentIntent-creation sites (storefront + ACP). The webhook/order/warehouse paths are untouched — the PI stays on the platform account. Status syncs pull-based (no new webhook endpoint). Dashboard gets a Payouts card in Settings backed by `dashboard.api.billing` + a browser-facing return/refresh splat route.

**Tech Stack:** Remix (Vite), Stripe Node SDK (mocked in tests via `vi.mock("stripe")`), Supabase (service-role, manual `.eq('shop_id')`), Vitest, `cd-*` dashboard primitives.

**Context / deviations (surfaced up front):**
- Working on branch `feat/billing-stripe-connect` in the main workspace, NOT a separate worktree — deviation from the CLAUDE.md worktree rule, justified because live verification (Task 9) needs this workspace's `.env.local`, node_modules, and Stripe/Supabase wiring; there is no other in-flight tracked work (clean status except untracked cruft).
- Stripe CLI is installed but not logged in; all CLI calls use `--api-key` / `STRIPE_API_KEY` sourced from `.env.local`'s `STRIPE_SECRET_KEY` (never printed). Task 9 aborts if the key is not `sk_test_`.
- Migrations apply to the remote Supabase project via the Supabase MCP `apply_migration` (CLI is unlinked).
- No new env keys, no new dependencies.

**File map:**

| File | Role |
|---|---|
| `supabase/migrations/20260702140000_stripe_connect.sql` | Create: `stripe_connected_account` + `payment_intent` additive columns |
| `app/lib/payments/stripe-client.server.ts` | Create: `getStripe()` singleton (extracted to break an import cycle) |
| `app/lib/payments/connect.server.ts` | Create: all Connect logic |
| `app/lib/payments/connect.server.test.ts` | Create: unit tests |
| `app/lib/payments/stripe.server.ts` | Modify: destination branch + stamping + fallback in `createPaymentIntent` |
| `app/lib/payments/stripe.server.test.ts` | Modify: new-column asserts + connected-path tests |
| `app/lib/commerce/acp/charge.server.ts` | Modify: same destination spread |
| `app/lib/commerce/acp/charge.server.test.ts` | Modify: destination + card-decline-no-retry tests |
| `app/routes/dashboard.api.billing.tsx` | Create: status DTO loader + intents action |
| `app/routes/__tests__/dashboard.api.billing.test.ts` | Create |
| `app/routes/dashboard.payouts.stripe.$.tsx` | Create: return/refresh browser legs |
| `app/routes/__tests__/dashboard.payouts.stripe.test.ts` | Create |
| `app/lib/dashboard/client.ts` | Modify: `fetchBilling` / `postBillingIntent` helpers |
| `app/components/dashboard/PayoutsCard.tsx` | Create: card component (thin JSX over view-model) |
| `app/components/dashboard/view-models.ts` | Modify: `payoutsCardState` pure view-model + `BillingDTO` type |
| `app/components/dashboard/__tests__/payouts-card.test.ts` | Create: view-model tests |
| `app/components/dashboard/screens/Settings.tsx` | Modify: render `<PayoutsCard app={app} />` section |

---

### Task 1: Migration — `stripe_connected_account` + `payment_intent` columns

**Files:**
- Create: `supabase/migrations/20260702140000_stripe_connect.sql`

- [ ] **Step 1: Confirm the timestamp sorts last**

Run: `ls supabase/migrations/ | tail -3`
Expected: the newest existing migration sorts before `20260702140000_...`. If not, bump the new filename past it.

- [ ] **Step 2: Write the migration**

```sql
-- Stripe Connect (spec 2026-07-02 #11): per-shop Express connected account for
-- destination charges + auto payouts, with a per-shop application fee knob
-- (default 0 = pilot comp). RLS mirrors payment_intent: service-role writes
-- bypass RLS; current_shop_id() read policy for the authenticated path.

create table public.stripe_connected_account (
  id                         uuid primary key default gen_random_uuid(),
  shop_id                    uuid not null references public.shops(id) on delete cascade,
  stripe_account_id          text not null,          -- acct_...
  account_type               text not null default 'express',
  charges_enabled            boolean not null default false,
  payouts_enabled            boolean not null default false,
  details_submitted          boolean not null default false,
  application_fee_bps        integer not null default 0 check (application_fee_bps between 0 and 10000),
  application_fee_flat_cents integer not null default 0 check (application_fee_flat_cents >= 0),
  country                    text not null default 'US',
  default_currency           text not null default 'usd',
  onboarded_at               timestamptz,            -- first time fully enabled
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  unique (shop_id),                                  -- one payout account per shop
  unique (stripe_account_id)
);

alter table public.stripe_connected_account enable row level security;
create policy stripe_connected_account_read on public.stripe_connected_account
  for select using (shop_id = public.current_shop_id());

-- Reconciliation truth on each PI: which charges auto-routed (acct_...) vs
-- platform charges still owed a manual payout; fee actually attached at create.
alter table public.payment_intent
  add column stripe_account_id     text,
  add column application_fee_cents integer;
```

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260702140000_stripe_connect.sql
git commit -m "migrations: stripe_connected_account + payment_intent routing columns (#11)"
```

(The migration is APPLIED to the remote project in Task 9 — unit tests in Tasks 2–7 mock Supabase and don't need it.)

---

### Task 2: `connect.server.ts` — Connect logic (TDD)

**Files:**
- Create: `app/lib/payments/stripe-client.server.ts`
- Modify: `app/lib/payments/stripe.server.ts` (extract `getStripe`, re-export)
- Create: `app/lib/payments/connect.server.ts`
- Test: `app/lib/payments/connect.server.test.ts`

**Why the extraction:** `connect.server.ts` needs `getStripe()`, and `stripe.server.ts` (Task 3) will import `destinationParamsFor` from `connect.server.ts`. Extracting the singleton into `stripe-client.server.ts` avoids the module cycle. `stripe.server.ts` re-exports `getStripe` so existing importers (`acp/charge.server.ts`) keep working; tests keep mocking the `"stripe"` package itself, so they're unaffected by which module instantiates it.

- [ ] **Step 1: Extract the client singleton**

Create `app/lib/payments/stripe-client.server.ts` with the exact singleton currently at `stripe.server.ts:7-17` (imports `Stripe` from `"stripe"`; reads `process.env.STRIPE_SECRET_KEY`; keeps the ponytail comment). In `stripe.server.ts`: delete the local singleton, add

```ts
import { getStripe } from "./stripe-client.server";
export { getStripe };
```

- [ ] **Step 2: Run existing payments tests — still green**

Run: `npx vitest run app/lib/payments/stripe.server.test.ts`
Expected: PASS (the `vi.mock("stripe")` package mock covers the new module).

- [ ] **Step 3: Write the failing tests**

`app/lib/payments/connect.server.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";

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
    expect(computeApplicationFeeCents(999, 250, 0)).toBe(25);     // round(24.975)
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
    const payload = h.updateEq.mock.calls[0][0];
    expect(payload).toMatchObject({ charges_enabled: true, payouts_enabled: true, details_submitted: true });
    expect(payload.onboarded_at).toEqual(expect.any(String));
  });

  it("does NOT overwrite an existing onboarded_at", async () => {
    h.maybeSingle.mockResolvedValue({ data: ROW, error: null });
    h.accountsRetrieve.mockResolvedValue({ charges_enabled: true, payouts_enabled: true, details_submitted: true });
    await syncAccountStatus("shop-1");
    expect(h.updateEq.mock.calls[0][0].onboarded_at).toBeUndefined();
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
      balance: { available: [{ amountCents: 5000, currency: "usd" }], pending: [{ amountCents: 1200, currency: "usd" }] },
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
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run app/lib/payments/connect.server.test.ts`
Expected: FAIL — `./connect.server` does not exist.

- [ ] **Step 5: Implement `app/lib/payments/connect.server.ts`**

```ts
import type Stripe from "stripe";
import { getStripe } from "./stripe-client.server";
import { getSupabase } from "~/lib/supabase.server";

/**
 * Stripe Connect (#11): per-shop Express connected account, destination-charge
 * params, pull-based status sync, and the dashboard billing DTO. The PI itself
 * stays on the platform account — nothing here touches the webhook/order path.
 */

export interface ConnectedAccountRow {
  shop_id: string;
  stripe_account_id: string;
  account_type: string;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
  application_fee_bps: number;
  application_fee_flat_cents: number;
  country: string;
  default_currency: string;
  onboarded_at: string | null;
}

export async function getConnectedAccount(shopId: string): Promise<ConnectedAccountRow | null> {
  const { data, error } = await getSupabase()
    .from("stripe_connected_account")
    .select("*")
    .eq("shop_id", shopId)
    .maybeSingle();
  if (error) throw error;
  return (data as ConnectedAccountRow | null) ?? null;
}

/** bps + flat, rounded half-up, clamped to [0, amount] (Stripe rejects fee > amount). */
export function computeApplicationFeeCents(amountCents: number, bps: number, flatCents: number): number {
  const fee = Math.round((amountCents * bps) / 10000) + flatCents;
  return Math.min(Math.max(fee, 0), amountCents);
}

export interface DestinationDecision {
  params: Partial<Pick<Stripe.PaymentIntentCreateParams, "transfer_data" | "on_behalf_of" | "application_fee_amount">>;
  stripeAccountId: string | null;
  applicationFeeCents: number | null; // null = no fee param attached
}

/**
 * The single routing decision, shared by BOTH PI-creation sites (storefront +
 * ACP). Routes ONLY to a fully-onboarded account — never strand buyer money in
 * a half-onboarded one; anything else charges the platform (today's behavior).
 */
export async function destinationParamsFor(shopId: string, amountCents: number): Promise<DestinationDecision> {
  const acct = await getConnectedAccount(shopId);
  if (!acct || !acct.charges_enabled || !acct.payouts_enabled || !acct.details_submitted) {
    return { params: {}, stripeAccountId: null, applicationFeeCents: null };
  }
  const fee = computeApplicationFeeCents(amountCents, acct.application_fee_bps, acct.application_fee_flat_cents);
  return {
    params: {
      transfer_data: { destination: acct.stripe_account_id },
      on_behalf_of: acct.stripe_account_id,
      ...(fee > 0 ? { application_fee_amount: fee } : {}),
    },
    stripeAccountId: acct.stripe_account_id,
    applicationFeeCents: fee > 0 ? fee : null,
  };
}

/** Base origin for the Stripe-hosted onboarding return/refresh redirects. */
export function onboardingOrigin(request: Request): string {
  return (
    process.env.DASHBOARD_PUBLIC_URL ?? process.env.SHOPIFY_APP_URL ?? new URL(request.url).origin
  ).replace(/\/$/, "");
}

/**
 * Create-or-reuse the Express account and mint a fresh hosted-onboarding link.
 * Idempotent on the account: one acct_ per shop (unique shop_id).
 * ponytail: two truly concurrent first clicks can orphan one test-mode Stripe
 * account (second insert loses on unique(shop_id)); harmless, not handled.
 */
export async function startOnboarding(shopId: string, origin: string): Promise<{ url: string }> {
  let acct = await getConnectedAccount(shopId);
  if (!acct) {
    const created = await getStripe().accounts.create({
      type: "express",
      country: "US",
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      metadata: { shop_id: shopId },
    });
    const ins = await getSupabase().from("stripe_connected_account").insert({
      shop_id: shopId,
      stripe_account_id: created.id,
      account_type: "express",
      country: created.country ?? "US",
      default_currency: created.default_currency ?? "usd",
    });
    if (ins.error) throw ins.error;
    acct = {
      shop_id: shopId,
      stripe_account_id: created.id,
      account_type: "express",
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: false,
      application_fee_bps: 0,
      application_fee_flat_cents: 0,
      country: created.country ?? "US",
      default_currency: created.default_currency ?? "usd",
      onboarded_at: null,
    };
  }
  const link = await getStripe().accountLinks.create({
    account: acct.stripe_account_id,
    type: "account_onboarding",
    return_url: `${origin}/dashboard/payouts/stripe/return`,
    refresh_url: `${origin}/dashboard/payouts/stripe/refresh`,
  });
  return { url: link.url };
}

/** Pull API truth into the row (return URL / Settings load / explicit refresh / self-heal). */
export async function syncAccountStatus(
  shopId: string,
): Promise<{ chargesEnabled: boolean; payoutsEnabled: boolean; detailsSubmitted: boolean } | null> {
  const acct = await getConnectedAccount(shopId);
  if (!acct) return null;
  const remote = await getStripe().accounts.retrieve(acct.stripe_account_id);
  const flags = {
    charges_enabled: Boolean(remote.charges_enabled),
    payouts_enabled: Boolean(remote.payouts_enabled),
    details_submitted: Boolean(remote.details_submitted),
  };
  const fullyEnabled = flags.charges_enabled && flags.payouts_enabled && flags.details_submitted;
  const upd = await getSupabase()
    .from("stripe_connected_account")
    .update({
      ...flags,
      updated_at: new Date().toISOString(),
      ...(fullyEnabled && !acct.onboarded_at ? { onboarded_at: new Date().toISOString() } : {}),
    })
    .eq("shop_id", shopId);
  if (upd.error) throw upd.error;
  return {
    chargesEnabled: flags.charges_enabled,
    payoutsEnabled: flags.payouts_enabled,
    detailsSubmitted: flags.details_submitted,
  };
}

export interface BillingDTO {
  connected: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  feeBps: number;
  feeFlatCents: number;
  balance: {
    available: Array<{ amountCents: number; currency: string }>;
    pending: Array<{ amountCents: number; currency: string }>;
  } | null;
  expressDashboardUrl: string | null;
}

/** Dashboard DTO (never the raw row). Live Stripe reads degrade to null, they never 500 the screen. */
export async function billingStatus(shopId: string): Promise<BillingDTO> {
  const acct = await getConnectedAccount(shopId);
  if (!acct) {
    return {
      connected: false,
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
      feeBps: 0,
      feeFlatCents: 0,
      balance: null,
      expressDashboardUrl: null,
    };
  }
  let balance: BillingDTO["balance"] = null;
  let expressDashboardUrl: string | null = null;
  if (acct.details_submitted) {
    try {
      const stripe = getStripe();
      const [bal, login] = await Promise.all([
        stripe.balance.retrieve({}, { stripeAccount: acct.stripe_account_id }),
        stripe.accounts.createLoginLink(acct.stripe_account_id),
      ]);
      const shape = (rows: Array<{ amount: number; currency: string }>) =>
        rows.map((r) => ({ amountCents: r.amount, currency: r.currency }));
      balance = { available: shape(bal.available), pending: shape(bal.pending) };
      expressDashboardUrl = login.url;
    } catch (err) {
      console.warn(`[stripe-connect] live balance read failed for shop ${shopId}: ${(err as Error).message}`);
    }
  }
  return {
    connected: true,
    chargesEnabled: acct.charges_enabled,
    payoutsEnabled: acct.payouts_enabled,
    detailsSubmitted: acct.details_submitted,
    feeBps: acct.application_fee_bps,
    feeFlatCents: acct.application_fee_flat_cents,
    balance,
    expressDashboardUrl,
  };
}
```

Note: the mock's `balance.retrieve` receives `({}, { stripeAccount })` — the test asserts via `mockResolvedValue`, not arg-matching, so the two-arg SDK form is fine.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run app/lib/payments/connect.server.test.ts app/lib/payments/stripe.server.test.ts`
Expected: PASS (both files).

- [ ] **Step 7: Commit**

```bash
git add app/lib/payments/stripe-client.server.ts app/lib/payments/connect.server.ts app/lib/payments/connect.server.test.ts app/lib/payments/stripe.server.ts
git commit -m "lib/payments: connect.server — Express account, destination params, status sync, billing DTO (#11)"
```

---

### Task 3: `createPaymentIntent` — destination branch + stamping + fallback

**Files:**
- Modify: `app/lib/payments/stripe.server.ts:26-67`
- Test: `app/lib/payments/stripe.server.test.ts`

- [ ] **Step 1: Extend the tests**

In `stripe.server.test.ts`: add to the hoisted handles `destinationParamsFor: vi.fn()`, `syncAccountStatus: vi.fn()`, then register (before the import line):

```ts
vi.mock("~/lib/payments/connect.server", () => ({
  destinationParamsFor: h.destinationParamsFor,
  syncAccountStatus: h.syncAccountStatus,
}));
```

In `beforeEach` add the platform default + sync stub:

```ts
h.destinationParamsFor.mockResolvedValue({ params: {}, stripeAccountId: null, applicationFeeCents: null });
h.syncAccountStatus.mockResolvedValue(null);
```

Update the FIRST existing `createPaymentIntent` test's insert assertion to include the new columns (platform path stamps nulls):

```ts
expect(h.insert).toHaveBeenCalledWith({
  shop_id: "shop-1",
  stripe_pi_id: "pi_1",
  order_ref: "order-1",
  amount_cents: 2500,
  currency: "usd",
  status: "requires_payment_method",
  stripe_account_id: null,
  application_fee_cents: null,
});
```

Append inside `describe("createPaymentIntent")`:

```ts
it("spreads destination params and stamps the routed acct + fee on the PI row", async () => {
  h.destinationParamsFor.mockResolvedValue({
    params: {
      transfer_data: { destination: "acct_1" },
      on_behalf_of: "acct_1",
      application_fee_amount: 280,
    },
    stripeAccountId: "acct_1",
    applicationFeeCents: 280,
  });
  h.piCreate.mockResolvedValue({ id: "pi_2", client_secret: "s", status: "requires_payment_method" });
  h.insert.mockResolvedValue({ error: null });

  await createPaymentIntent("shop-1", 10000, "usd", "order-2");

  expect(h.piCreate).toHaveBeenCalledWith({
    amount: 10000,
    currency: "usd",
    automatic_payment_methods: { enabled: true },
    metadata: { shop_id: "shop-1", order_ref: "order-2" },
    transfer_data: { destination: "acct_1" },
    on_behalf_of: "acct_1",
    application_fee_amount: 280,
  });
  expect(h.insert).toHaveBeenCalledWith(
    expect.objectContaining({ stripe_account_id: "acct_1", application_fee_cents: 280 }),
  );
});

it("falls back to a platform charge when the destination create is rejected (checkout never breaks)", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  h.destinationParamsFor.mockResolvedValue({
    params: { transfer_data: { destination: "acct_1" }, on_behalf_of: "acct_1" },
    stripeAccountId: "acct_1",
    applicationFeeCents: null,
  });
  const stripeErr = Object.assign(new Error("account cannot receive transfers"), {
    type: "StripeInvalidRequestError",
  });
  h.piCreate
    .mockRejectedValueOnce(stripeErr)
    .mockResolvedValueOnce({ id: "pi_3", client_secret: "s3", status: "requires_payment_method" });
  h.insert.mockResolvedValue({ error: null });

  const out = await createPaymentIntent("shop-1", 2500, "usd", "order-3");

  expect(out.paymentIntentId).toBe("pi_3");
  // Second attempt carries NO connect params.
  expect(h.piCreate.mock.calls[1][0]).toEqual({
    amount: 2500,
    currency: "usd",
    automatic_payment_methods: { enabled: true },
    metadata: { shop_id: "shop-1", order_ref: "order-3" },
  });
  // Row records the truth: platform charge, no fee.
  expect(h.insert).toHaveBeenCalledWith(
    expect.objectContaining({ stripe_account_id: null, application_fee_cents: null }),
  );
  expect(warn).toHaveBeenCalledWith(expect.stringMatching(/falling back to platform charge/));
  expect(h.syncAccountStatus).toHaveBeenCalledWith("shop-1"); // self-heal the stale flags
  warn.mockRestore();
});

it("does NOT swallow non-destination errors (no blind retry)", async () => {
  h.destinationParamsFor.mockResolvedValue({
    params: { transfer_data: { destination: "acct_1" }, on_behalf_of: "acct_1" },
    stripeAccountId: "acct_1",
    applicationFeeCents: null,
  });
  h.piCreate.mockRejectedValue(Object.assign(new Error("rate limited"), { type: "StripeRateLimitError" }));
  await expect(createPaymentIntent("shop-1", 2500, "usd")).rejects.toThrow(/rate limited/);
  expect(h.piCreate).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run app/lib/payments/stripe.server.test.ts`
Expected: FAIL — new tests red (and the updated insert assertion red) until implementation.

- [ ] **Step 3: Implement in `stripe.server.ts`**

Add import: `import { destinationParamsFor, syncAccountStatus } from "./connect.server";`

Replace the body of `createPaymentIntent` between the currency validation and the return (current lines 41-59) with:

```ts
  const dest = await destinationParamsFor(shopId, amountCents);
  const base = {
    amount: amountCents,
    currency: cur,
    automatic_payment_methods: { enabled: true as const },
    metadata: { shop_id: shopId, order_ref: orderRef ?? "" },
  };

  let routedAccountId = dest.stripeAccountId;
  let appliedFeeCents = dest.applicationFeeCents;
  let pi: Stripe.PaymentIntent;
  try {
    pi = await getStripe().paymentIntents.create({ ...base, ...dest.params });
  } catch (err) {
    // Destination-specific rejection (half-onboarded/restricted account) must not
    // break checkout: retry as a platform charge (= today's behavior, manually
    // settleable) and re-sync the stale flags. Anything else propagates (rule 12).
    if (routedAccountId && (err as { type?: string }).type === "StripeInvalidRequestError") {
      console.warn(
        `[stripe-connect] destination charge for shop ${shopId} rejected (${(err as Error).message}); falling back to platform charge`,
      );
      void syncAccountStatus(shopId).catch((e) =>
        console.warn(`[stripe-connect] status re-sync failed for shop ${shopId}: ${(e as Error).message}`),
      );
      routedAccountId = null;
      appliedFeeCents = null;
      pi = await getStripe().paymentIntents.create(base);
    } else {
      throw err;
    }
  }
  if (!pi.client_secret) {
    throw new Error(`Stripe PaymentIntent ${pi.id} returned no client_secret`);
  }

  const { error } = await getSupabase().from("payment_intent").insert({
    shop_id: shopId,
    stripe_pi_id: pi.id,
    order_ref: orderRef ?? null,
    amount_cents: amountCents,
    currency: cur,
    status: pi.status,
    stripe_account_id: routedAccountId,
    application_fee_cents: appliedFeeCents,
  });
  if (error) throw error;
```

(Keep the existing `import Stripe from "stripe"` type usage — `pi` is typed `Stripe.PaymentIntent`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run app/lib/payments/stripe.server.test.ts`
Expected: PASS — all existing + new.

- [ ] **Step 5: Commit**

```bash
git add app/lib/payments/stripe.server.ts app/lib/payments/stripe.server.test.ts
git commit -m "lib/payments: route createPaymentIntent through destination params with platform fallback (#11)"
```

---

### Task 4: ACP charge path — same routing (agentic checkout parity)

**Files:**
- Modify: `app/lib/commerce/acp/charge.server.ts:32-49`
- Test: `app/lib/commerce/acp/charge.server.test.ts`

- [ ] **Step 1: Read the existing test file, then extend it**

Add the same `vi.mock("~/lib/payments/connect.server", ...)` + hoisted handles as Task 3 Step 1 (platform default in `beforeEach`). Add tests:

```ts
it("spreads destination params into the SPT charge and stamps the row", async () => {
  h.destinationParamsFor.mockResolvedValue({
    params: { transfer_data: { destination: "acct_1" }, on_behalf_of: "acct_1" },
    stripeAccountId: "acct_1",
    applicationFeeCents: null,
  });
  h.piCreate.mockResolvedValue({ id: "pi_spt", status: "succeeded" });

  await chargeSharedPaymentToken("shop-1", {
    orderId: "order-9",
    totalCents: 5000,
    currency: "usd",
    sharedPaymentToken: "spt_1",
  });

  expect(h.piCreate).toHaveBeenCalledWith(
    expect.objectContaining({
      transfer_data: { destination: "acct_1" },
      on_behalf_of: "acct_1",
      payment_method: "spt_1",
      confirm: true,
    }),
  );
  expect(h.insert).toHaveBeenCalledWith(
    expect.objectContaining({ stripe_account_id: "acct_1", application_fee_cents: null }),
  );
});

it("a card DECLINE (confirm:true) is NOT retried as a platform charge — declines propagate", async () => {
  h.destinationParamsFor.mockResolvedValue({
    params: { transfer_data: { destination: "acct_1" }, on_behalf_of: "acct_1" },
    stripeAccountId: "acct_1",
    applicationFeeCents: null,
  });
  h.piCreate.mockRejectedValue(Object.assign(new Error("card declined"), { type: "StripeCardError" }));

  await expect(
    chargeSharedPaymentToken("shop-1", {
      orderId: "order-9",
      totalCents: 5000,
      currency: "usd",
      sharedPaymentToken: "spt_1",
    }),
  ).rejects.toThrow(/card declined/);
  expect(h.piCreate).toHaveBeenCalledTimes(1); // NEVER double-attempt a confirmed charge on a decline
});

it("falls back to platform on a destination-invalid rejection", async () => {
  h.destinationParamsFor.mockResolvedValue({
    params: { transfer_data: { destination: "acct_1" }, on_behalf_of: "acct_1" },
    stripeAccountId: "acct_1",
    applicationFeeCents: null,
  });
  h.piCreate
    .mockRejectedValueOnce(Object.assign(new Error("no transfers"), { type: "StripeInvalidRequestError" }))
    .mockResolvedValueOnce({ id: "pi_fb", status: "succeeded" });

  const out = await chargeSharedPaymentToken("shop-1", {
    orderId: "order-9",
    totalCents: 5000,
    currency: "usd",
    sharedPaymentToken: "spt_1",
  });
  expect(out.paymentIntentId).toBe("pi_fb");
  expect(h.piCreate.mock.calls[1][0]).not.toHaveProperty("transfer_data");
});
```

(Adapt handle names to that file's existing hoisted-mock structure — same `h.piCreate` / `h.insert` idiom as `stripe.server.test.ts`.)

- [ ] **Step 2: Run to verify new tests fail**

Run: `npx vitest run app/lib/commerce/acp/charge.server.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement in `charge.server.ts`**

```ts
import { destinationParamsFor, syncAccountStatus } from "~/lib/payments/connect.server";
```

Replace lines 32-49 with:

```ts
  const dest = await destinationParamsFor(shopId, input.totalCents);
  const base = {
    amount: input.totalCents,
    currency: input.currency.toLowerCase(),
    payment_method: input.sharedPaymentToken,
    confirm: true as const,
    off_session: true as const,
    metadata: { shop_id: shopId, order_ref: input.orderId },
  };

  let routedAccountId = dest.stripeAccountId;
  let appliedFeeCents = dest.applicationFeeCents;
  let pi;
  try {
    pi = await getStripe().paymentIntents.create({ ...base, ...dest.params });
  } catch (err) {
    // ONLY a destination-shaped invalid-request falls back; a card decline
    // (StripeCardError) must propagate — retrying a confirm:true create on a
    // decline would double-attempt the buyer's charge.
    if (routedAccountId && (err as { type?: string }).type === "StripeInvalidRequestError") {
      console.warn(
        `[stripe-connect] ACP destination charge for shop ${shopId} rejected (${(err as Error).message}); falling back to platform charge`,
      );
      void syncAccountStatus(shopId).catch((e) =>
        console.warn(`[stripe-connect] status re-sync failed for shop ${shopId}: ${(e as Error).message}`),
      );
      routedAccountId = null;
      appliedFeeCents = null;
      pi = await getStripe().paymentIntents.create(base);
    } else {
      throw err;
    }
  }
  // Mirror into payment_intent so the webhook + reconciliation can resolve the order
  // (same path as createPaymentIntent for the storefront flow).
  await getSupabase().from("payment_intent").insert({
    shop_id: shopId,
    stripe_pi_id: pi.id,
    order_ref: input.orderId,
    amount_cents: input.totalCents,
    currency: input.currency.toLowerCase(),
    status: pi.status,
    stripe_account_id: routedAccountId,
    application_fee_cents: appliedFeeCents,
  });
```

(Existing insert assertions in that test file gain the two null columns — update them like Task 3.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run app/lib/commerce/acp/charge.server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/commerce/acp/charge.server.ts app/lib/commerce/acp/charge.server.test.ts
git commit -m "commerce/acp: route SPT charges through destination params, declines never retried (#11)"
```

---

### Task 5: `dashboard.api.billing` route + client helpers

**Files:**
- Create: `app/routes/dashboard.api.billing.tsx`
- Modify: `app/lib/dashboard/client.ts` (read it first; match its helper style exactly)
- Test: `app/routes/__tests__/dashboard.api.billing.test.ts`

- [ ] **Step 1: Write the failing route test**

`app/routes/__tests__/dashboard.api.billing.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  requireDashboardSession: vi.fn(),
  billingStatus: vi.fn(),
  startOnboarding: vi.fn(),
  syncAccountStatus: vi.fn(),
}));

vi.mock("~/lib/dashboard/session.server", () => ({ requireDashboardSession: h.requireDashboardSession }));
vi.mock("~/lib/payments/connect.server", () => ({
  billingStatus: h.billingStatus,
  startOnboarding: h.startOnboarding,
  syncAccountStatus: h.syncAccountStatus,
  onboardingOrigin: () => "https://app.example.com",
}));

// eslint-disable-next-line import/first -- import must follow vi.mock
import { loader, action } from "../dashboard.api.billing";

const DTO = {
  connected: false, chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false,
  feeBps: 0, feeFlatCents: 0, balance: null, expressDashboardUrl: null,
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
    const res = await loader({ request: new Request("https://app.example.com/dashboard/api/billing"), params: {}, context: {} } as never);
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/routes/__tests__/dashboard.api.billing.test.ts`
Expected: FAIL — route module missing.

- [ ] **Step 3: Implement the route**

`app/routes/dashboard.api.billing.tsx`:

```tsx
// Payouts / billing status for the dashboard Settings screen (#11 Stripe Connect).
// GET returns the BillingDTO; POST {intent} starts hosted onboarding or re-syncs
// account status. All Stripe/DB work lives in connect.server — this is the boundary.

import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import {
  billingStatus,
  startOnboarding,
  syncAccountStatus,
  onboardingOrigin,
} from "~/lib/payments/connect.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(() => billingStatus(session.shopId));
}

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError(422, "invalid_json");
  }

  if (body.intent === "start-onboarding") {
    return dashboardJson(() => startOnboarding(session.shopId, onboardingOrigin(request)));
  }
  if (body.intent === "refresh-status") {
    return dashboardJson(async () => {
      await syncAccountStatus(session.shopId);
      return billingStatus(session.shopId);
    });
  }
  return jsonError(422, "invalid_intent");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run app/routes/__tests__/dashboard.api.billing.test.ts`
Expected: PASS.

- [ ] **Step 5: Add client helpers**

Read `app/lib/dashboard/client.ts` first; add, in its exact existing style (same error type / base-path helper the file already uses — e.g. how `putConsent`/`fetchShipCost` are built):

```ts
export type BillingStatus = {
  connected: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  feeBps: number;
  feeFlatCents: number;
  balance: {
    available: Array<{ amountCents: number; currency: string }>;
    pending: Array<{ amountCents: number; currency: string }>;
  } | null;
  expressDashboardUrl: string | null;
};

export function fetchBilling(): Promise<BillingStatus> { /* GET /dashboard/api/billing via the file's shared fetch helper */ }
export function startPayoutOnboarding(): Promise<{ url: string }> { /* POST {intent:"start-onboarding"} */ }
export function refreshPayoutStatus(): Promise<BillingStatus> { /* POST {intent:"refresh-status"} */ }
```

The bodies MUST reuse the file's shared request helper (whatever `putConsent` uses) — do not hand-roll a second fetch envelope. If the file has no shared helper, mirror `putConsent`'s body verbatim with the new path/method.

- [ ] **Step 6: Commit**

```bash
git add app/routes/dashboard.api.billing.tsx app/routes/__tests__/dashboard.api.billing.test.ts app/lib/dashboard/client.ts
git commit -m "routes/dashboard.api.billing: payouts status DTO + onboarding/refresh intents (#11)"
```

---

### Task 6: `dashboard.payouts.stripe.$` — return/refresh browser legs

**Files:**
- Create: `app/routes/dashboard.payouts.stripe.$.tsx`
- Test: `app/routes/__tests__/dashboard.payouts.stripe.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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

// eslint-disable-next-line import/first -- import must follow vi.mock
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
  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).toBe("https://connect.stripe.com/setup/z");
});

it("404s any other leg", async () => {
  await expect(call("nope")).rejects.toMatchObject({ status: 404 });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/routes/__tests__/dashboard.payouts.stripe.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`app/routes/dashboard.payouts.stripe.$.tsx`:

```tsx
// Browser-facing legs of Stripe-hosted Express onboarding (#11).
//   /dashboard/payouts/stripe/return  — merchant came back: pull API truth, land in the dashboard
//   /dashboard/payouts/stripe/refresh — expired/invalid link: mint a fresh one, bounce to Stripe
// The dashboard session cookie authenticates both (top-level GET on our origin);
// no nonce needed — nothing here trusts query params.

import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { onboardingOrigin, startOnboarding, syncAccountStatus } from "~/lib/payments/connect.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const session = await requireDashboardSession(request);
  const leg = params["*"];

  if (leg === "return") {
    await syncAccountStatus(session.shopId);
    return redirect("/dashboard?payouts=updated");
  }
  if (leg === "refresh") {
    const { url } = await startOnboarding(session.shopId, onboardingOrigin(request));
    return redirect(url);
  }
  throw new Response("Not found", { status: 404 });
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run app/routes/__tests__/dashboard.payouts.stripe.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/routes/dashboard.payouts.stripe.\$.tsx app/routes/__tests__/dashboard.payouts.stripe.test.ts
git commit -m "routes/dashboard.payouts.stripe: hosted-onboarding return/refresh legs (#11)"
```

---

### Task 7: Payouts card in Settings

**Files:**
- Modify: `app/components/dashboard/view-models.ts` (append view-model)
- Create: `app/components/dashboard/PayoutsCard.tsx`
- Test: `app/components/dashboard/__tests__/payouts-card.test.ts`
- Modify: `app/components/dashboard/screens/Settings.tsx` (render the card)

Convention note: dashboard component tests are pure-logic `.test.ts` (no testing-library) — so the card's states live in a pure `payoutsCardState` view-model and the JSX stays thin.

- [ ] **Step 1: Write the failing view-model test**

`app/components/dashboard/__tests__/payouts-card.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { payoutsCardState } from "../view-models";

const BASE = {
  connected: false, chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false,
  feeBps: 0, feeFlatCents: 0, balance: null, expressDashboardUrl: null,
};

describe("payoutsCardState", () => {
  it("not connected → setup CTA", () => {
    expect(payoutsCardState(BASE)).toEqual({
      phase: "not_connected",
      pillTone: "neutral",
      pillLabel: "Not set up",
      cta: "setup",
      feeLabel: "Platform fee: 0% — pilot",
    });
  });

  it("connected but incomplete → resume CTA, warn pill", () => {
    expect(payoutsCardState({ ...BASE, connected: true, detailsSubmitted: true })).toMatchObject({
      phase: "onboarding",
      pillTone: "warn",
      pillLabel: "Onboarding incomplete",
      cta: "resume",
    });
  });

  it("fully enabled → active, no CTA", () => {
    expect(
      payoutsCardState({ ...BASE, connected: true, chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true }),
    ).toMatchObject({ phase: "active", pillTone: "success", pillLabel: "Payouts active", cta: null });
  });

  it("formats a non-zero fee", () => {
    expect(payoutsCardState({ ...BASE, feeBps: 250, feeFlatCents: 30 }).feeLabel).toBe(
      "Platform fee: 2.5% + $0.30",
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/components/dashboard/__tests__/payouts-card.test.ts`
Expected: FAIL — `payoutsCardState` not exported.

- [ ] **Step 3: Implement the view-model** (append to `app/components/dashboard/view-models.ts`)

```ts
/* ---------- Payouts (Stripe Connect, #11) ---------- */

export interface PayoutsVM {
  phase: "not_connected" | "onboarding" | "active";
  pillTone: "neutral" | "warn" | "success";
  pillLabel: string;
  cta: "setup" | "resume" | null;
  feeLabel: string;
}

export function payoutsCardState(dto: {
  connected: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  feeBps: number;
  feeFlatCents: number;
}): PayoutsVM {
  const feeLabel =
    dto.feeBps === 0 && dto.feeFlatCents === 0
      ? "Platform fee: 0% — pilot"
      : `Platform fee: ${dto.feeBps / 100}%${dto.feeFlatCents > 0 ? ` + $${(dto.feeFlatCents / 100).toFixed(2)}` : ""}`;
  if (!dto.connected) {
    return { phase: "not_connected", pillTone: "neutral", pillLabel: "Not set up", cta: "setup", feeLabel };
  }
  const active = dto.chargesEnabled && dto.payoutsEnabled && dto.detailsSubmitted;
  if (!active) {
    return { phase: "onboarding", pillTone: "warn", pillLabel: "Onboarding incomplete", cta: "resume", feeLabel };
  }
  return { phase: "active", pillTone: "success", pillLabel: "Payouts active", cta: null, feeLabel };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run app/components/dashboard/__tests__/payouts-card.test.ts`
Expected: PASS.

- [ ] **Step 5: Create the card component**

`app/components/dashboard/PayoutsCard.tsx` (thin JSX over the view-model; extracted-component precedent: `BusinessHoursEditor.tsx`, `McpGuide.tsx`):

```tsx
import { useEffect, useState } from "react";
import { Card, SectionTitle, Pill } from "./ui";
import { money } from "./format";
import {
  fetchBilling,
  startPayoutOnboarding,
  refreshPayoutStatus,
  DashboardApiError,
  type BillingStatus,
} from "~/lib/dashboard/client";
import { payoutsCardState } from "./view-models";
import type { DashboardCtx } from "./context";

/** Payouts (Stripe Connect): onboarding CTA, status, live balance, fee line. */
export function PayoutsCard({ app }: { app: DashboardCtx }) {
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    fetchBilling()
      .then((d) => {
        if (active) setBilling(d);
      })
      .catch(() => {
        /* card renders the not-loaded placeholder until reachable */
      });
    return () => {
      active = false;
    };
  }, []);

  const onCta = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { url } = await startPayoutOnboarding();
      window.location.assign(url); // top-level hop to Stripe-hosted onboarding
    } catch (err) {
      const message = err instanceof DashboardApiError ? err.message : "Couldn't start payout setup.";
      app.toast(message, "x", "critical");
      setBusy(false);
    }
  };

  const onRefresh = async () => {
    if (busy) return;
    setBusy(true);
    try {
      setBilling(await refreshPayoutStatus());
      app.toast("Payout status refreshed", "check");
    } catch (err) {
      const message = err instanceof DashboardApiError ? err.message : "Couldn't refresh payout status.";
      app.toast(message, "x", "critical");
    } finally {
      setBusy(false);
    }
  };

  const vm = billing ? payoutsCardState(billing) : null;
  const available = billing?.balance?.available?.[0];

  return (
    <section>
      <SectionTitle>Payouts</SectionTitle>
      <Card>
        {!vm || !billing ? (
          <div className="cd-caption">Loading payout status…</div>
        ) : (
          <>
            <div className="cd-setting">
              <div className="min-w-0 flex-1">
                <div className="cd-row-title">
                  Stripe payouts <Pill tone={vm.pillTone}>{vm.pillLabel}</Pill>
                </div>
                <div className="cd-caption" style={{ maxWidth: "46ch" }}>
                  {vm.phase === "active"
                    ? "Buyer payments route to your Stripe account and pay out automatically."
                    : "Connect a payout account so buyer payments land in your bank automatically."}
                </div>
                <div className="cd-caption">{vm.feeLabel}</div>
                {vm.phase === "active" && available && (
                  <div className="cd-caption">
                    Balance: {money(available.amountCents / 100)} available
                    {billing.balance!.pending[0]
                      ? ` · ${money(billing.balance!.pending[0].amountCents / 100)} pending`
                      : ""}
                  </div>
                )}
              </div>
              {vm.cta ? (
                <button className="cd-btn" onClick={onCta} disabled={busy}>
                  {vm.cta === "setup" ? "Set up payouts" : "Resume onboarding"}
                </button>
              ) : (
                <button className="cd-btn" onClick={onRefresh} disabled={busy}>
                  Refresh
                </button>
              )}
            </div>
            {vm.phase === "active" && billing.expressDashboardUrl && (
              <div className="cd-caption">
                <a href={billing.expressDashboardUrl} target="_blank" rel="noreferrer">
                  Open Stripe payout dashboard
                </a>
              </div>
            )}
          </>
        )}
      </Card>
    </section>
  );
}
```

Adapt at execution to the REAL primitives: check `ui.tsx` for the button idiom (`cd-btn` vs a `Button` component) and `Pill`'s prop names; match `money()`'s actual signature (`format.ts`). Do not invent new CSS classes — reuse what Settings already uses.

- [ ] **Step 6: Render it in Settings**

In `app/components/dashboard/screens/Settings.tsx`: `import { PayoutsCard } from "../PayoutsCard";` and add `<PayoutsCard app={app} />` as a new section directly after the Connections section (the `</section>` near line 501).

- [ ] **Step 7: Full test file sweep**

Run: `npx vitest run app/components/dashboard`
Expected: PASS (all dashboard component tests).

- [ ] **Step 8: Commit**

```bash
git add app/components/dashboard/PayoutsCard.tsx app/components/dashboard/view-models.ts app/components/dashboard/__tests__/payouts-card.test.ts app/components/dashboard/screens/Settings.tsx
git commit -m "components/dashboard: Payouts card in Settings — onboarding CTA, status, balance (#11)"
```

---

### Task 8: Full gate

- [ ] **Step 1: Full suite** — `npm run test` → exit 0 (previously 548 tests + new).
- [ ] **Step 2: Types** — `npm run typecheck` → exit 0.
- [ ] **Step 3: Lint** — `npm run lint` → exit 0 (no warnings on touched files).
- [ ] **Step 4: Build** — `npm run build` → exit 0 (includes `verify-client-bundle`; the card must not leak server code — `client.ts` helpers are the only client-side addition).
- [ ] **Step 5: Patch sanity** — `git diff main --stat` + `git diff main --check`; scan the diff for stray `console.log`, `.only`, provenance markers.
- [ ] **Step 6: Commit anything outstanding** (should be none — Tasks 1-7 each committed).

---

### Task 9: Live verification — Stripe CLI (api-key mode) against the real test account

Everything below uses `STRIPE_API_KEY` exported from `.env.local`'s `STRIPE_SECRET_KEY` for the CLI, and asserts DB state via Supabase MCP `execute_sql`. **Paste real outputs; never assert success without them (rule 12).**

- [ ] **Step 1: Safety gate** — `grep -oE '^STRIPE_SECRET_KEY=sk_(test|live)' .env.local` → MUST print `sk_test`. If `sk_live`, STOP and ask the user.
- [ ] **Step 2: Apply the migration** — Supabase MCP `apply_migration` with the Task 1 SQL (name `stripe_connect`). Verify: `select column_name from information_schema.columns where table_name='payment_intent'` includes the two new columns.
- [ ] **Step 3: Pick the dev shop** — inspect `scripts/reset-test-store.sh` for the canonical test shop; else `select id, shop_domain from shops order by created_at limit 5` and use the known dev/test shop.
- [ ] **Step 4: Start the app + webhook forward** —
  - `STRIPE_WEBHOOK_SECRET=$(stripe listen --api-key "$KEY" --print-secret)` (deterministic listen secret),
  - start dev server in background with that secret exported (`npx remix vite:dev` or `npx vite dev`, whichever serves; port noted),
  - `stripe listen --api-key "$KEY" --forward-to localhost:<port>/webhooks/stripe` in background.
- [ ] **Step 5: Platform path (regression)** — create a real order via the checkout server path (`startCheckout` from `app/lib/order/checkout.server.ts` via an `npx tsx` scratchpad script with env loaded — read its signature first), producing a PI with `order_ref`; `stripe payment_intents confirm <pi> --api-key "$KEY" --payment-method pm_card_visa --return-url https://example.com/done`. Expect: webhook 200 in listen output; DB: `payment_intent.status='succeeded'`, `stripe_account_id IS NULL`, ledger `capture` row, `orders.state='paid'`, `order_fact` emitted.
- [ ] **Step 6: Connected account** — run `startOnboarding` for the shop via tsx script → Express `acct_...` created + row inserted + a live `https://connect.stripe.com/...` URL printed (onboarding-flow check). For a deterministically ENABLED account (hosted KYC can't be completed headlessly): create a pre-verified test account via CLI (`stripe accounts create --type=custom` with test tos/dob/ssn `0000`/bank token per Stripe test data), `update stripe_connected_account set stripe_account_id='<acct>'` via `execute_sql`, then run `syncAccountStatus` via tsx → flags flip true, `onboarded_at` stamped. (If Custom-type creation is rejected on this platform config, fall back to driving the Express test-mode hosted flow via the chrome-devtools MCP — test mode offers prefilled/skip affordances.)
- [ ] **Step 7: Destination path** — repeat Step 5 with the now-enabled account. Expect additionally: `stripe payment_intents retrieve <pi>` shows `transfer_data.destination=<acct>` + `on_behalf_of`; DB row has `stripe_account_id='<acct>'`; `stripe transfers list --api-key "$KEY"` shows the transfer; `stripe balance retrieve --api-key "$KEY" --stripe-account <acct>` shows the pending funds on the connected account.
- [ ] **Step 8: Fee knob** — `update stripe_connected_account set application_fee_bps=250` via `execute_sql`; create one more PI; `retrieve` shows `application_fee_amount` = 2.5% (and DB `application_fee_cents` matches); reset bps to 0.
- [ ] **Step 9: Negative paths** — (a) `stripe trigger payment_intent.succeeded --api-key "$KEY"` (foreign PI, no `shop_id` metadata) → listen shows 200, server log shows the ignore-warn, no DB writes; (b) point the row at a bogus `acct_` + force flags true via `execute_sql`, create a PI → server warn `falling back to platform charge`, PI created platform-side, row stamped null (then restore the row).
- [ ] **Step 10: Cleanup + evidence** — kill background processes; restore any test-forced DB values; summarize each path with its observed output in the final report.

---

### Task 10: Wrap-up

- [ ] **Step 1: `/code-review`** on the working tree (pre-commit gate order: review → sanity → evals; evals already green from Task 8 — re-run any that the review's fixes dirty).
- [ ] **Step 2:** Final `git log --oneline main..HEAD` — one logical change per commit, subjects reference modules.
- [ ] **Step 3:** Report: per-path verification evidence, the worktree deviation, and the platform-pivot progress footer (spec-feature PR rule) if/when a PR is opened.
