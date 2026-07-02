# #11 Billing — Stripe Connect payouts + platform fee (design)

Date: 2026-07-02
Status: approved-pending-spec-review
Supersedes: platform-pivot spec §#11 ("Shopify-native billing / appSubscriptionCreate")

## 1. Summary & scope decision

The pivot spec's §#11 assumed Shopify's Billing API — charges landing on the merchant's
Shopify invoice. That mechanism dies with the retired embedded app: post-pivot there is no
Shopify invoice to ride. **Conflict resolution (rule 7):** #11 is reframed onto the rail we
already own. Buyer money today lands in Calderyn's single platform Stripe account
(`createPaymentIntent`, `payments/stripe.server.ts`) and merchants are paid manually — the
"comp / manual-invoice" pilot posture.

**#11 = Stripe Connect, one rail for both problems:**

- **Payout automation** — per-merchant Express connected accounts; each charge routes
  `amount − fee` to the merchant's account; Stripe auto-pays out to their bank.
- **Monetization** — a per-shop **application fee** (bps + flat, default **0** = comp) taken
  on the same charge. Flipping the fee knob later *is* "charge merchants"; no separate
  subscription system. (A recurring SaaS plan, if ever wanted, is a future feature.)

## 2. Money flow

```
TODAY (platform charge):
  buyer card ─▶ PI on CALDERYN account ─▶ Calderyn balance ─▶ manual payout (comp)

CONNECT (destination charge):
  buyer card ─▶ PI on CALDERYN account
                 transfer_data.destination = acct_merchant
                 on_behalf_of              = acct_merchant
                 application_fee_amount    = fee (omit when 0)
                 ▼
        ├─ amount − fee ─▶ merchant connected acct ─▶ AUTO payout ─▶ merchant bank
        └─ fee ──────────▶ Calderyn platform balance
```

The PI stays on the platform account, so the existing webhook
(`payment_intent.succeeded` keyed on `pi.metadata.shop_id`, `record_stripe_event`,
order transition, warehouse emit) is **untouched**. Connect is an additive branch at PI
creation, not a payment-path rewrite.

**Economics (must be understood before pilot):** on destination charges Stripe's processing
fee (~2.9% + 30¢) is debited from the **platform**, regardless of `on_behalf_of`
(`on_behalf_of` sets settlement merchant / statement descriptor / fee-schedule country — not
the fee payer). Therefore:

| application fee | merchant receives | Calderyn nets |
|---|---|---|
| 0 (pilot comp) | 100% of amount | **− stripe_fee** (Calderyn eats processing) |
| ≥ stripe_fee + margin | amount − fee | fee − stripe_fee |

Fee=0 comp is a real, visible cost, not a free default. Verify current fee-payer behavior
against Stripe docs at implement time.

## 3. Locked decisions

| Decision | Choice | Why |
|---|---|---|
| Account type | **Express** (`card_payments` + `transfers` capabilities) | Stripe-hosted KYC/onboarding, merchant gets Express dashboard, least liability |
| Charge model | **Destination charges** | Smallest delta over built code; single merchant per order |
| Seller of record | `on_behalf_of = merchant` | Merchant's name on buyer's card statement (fewer disputes); merchant sells own goods |
| Routing gate | `charges_enabled && payouts_enabled && details_submitted` | Never strand buyer money in a half-onboarded account |
| Un-gated / failed routing | **Fall back to platform charge** (today's behavior) | Checkout never breaks because of payout plumbing |
| Pilot fee | `application_fee_bps = 0`, `application_fee_flat_cents = 0` per shop | Comp posture; knob is per-shop columns, no code change to flip |
| Status sync | **Pull-based** (return URL + Settings load + explicit refresh) | No Connect webhook endpoint in pilot; fast-follow below |

## 4. Data model

New migration (RLS posture mirrors `payment_intent`: service-role writes bypass RLS, a
`current_shop_id()` read policy for the authenticated path):

```sql
create table public.stripe_connected_account (
  id                        uuid primary key default gen_random_uuid(),
  shop_id                   uuid not null references public.shops(id) on delete cascade,
  stripe_account_id         text not null,          -- acct_...
  account_type              text not null default 'express',
  charges_enabled           boolean not null default false,
  payouts_enabled           boolean not null default false,
  details_submitted         boolean not null default false,
  application_fee_bps       integer not null default 0 check (application_fee_bps between 0 and 10000),
  application_fee_flat_cents integer not null default 0 check (application_fee_flat_cents >= 0),
  country                   text not null default 'US',
  default_currency          text not null default 'usd',
  onboarded_at              timestamptz,            -- first time fully enabled
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (shop_id),                                 -- one payout account per shop
  unique (stripe_account_id)
);
```

Additive columns on `payment_intent` (reconciliation truth: which orders auto-routed vs
still owed a manual payout):

```sql
alter table public.payment_intent
  add column stripe_account_id     text,     -- null = platform charge (manual settlement)
  add column application_fee_cents integer;  -- fee attached at create; null = none
```

No `transaction_ledger` schema change — `'fee'` / `'payout'` kinds already exist
(20260628120000 line 32); **emission stays deferred** (§8).

## 5. Code changes

**`app/lib/payments/connect.server.ts` (new)** — all Connect logic in one server module:

- `getConnectedAccount(shopId)` — row lookup.
- `destinationParamsFor(shopId, amountCents)` — returns `{ transfer_data, on_behalf_of, application_fee_amount? }`
  when the routing gate passes, else `{}`. Fee math:
  `fee = clamp(round(amount * bps / 10000) + flat, 0, amount)`; **omit** the param when 0.
  Shared by BOTH PI-creation sites (below) so agentic orders route identically.
- `startOnboarding(shopId, origin)` — idempotent: reuse existing `stripe_account_id` or
  `accounts.create({ type: 'express', country, capabilities: { card_payments, transfers } })`;
  then `accountLinks.create({ type: 'account_onboarding', return_url, refresh_url })`; returns URL.
- `syncAccountStatus(shopId)` — `accounts.retrieve` → update the three flags (+ stamp
  `onboarded_at` on first full-enable). Idempotent by construction (writes API truth).
- `getPayoutSnapshot(shopId)` — live `balance.retrieve({ stripeAccount })` for the UI; plus
  `accounts.createLoginLink` so the merchant can one-click into their Express dashboard.

**PI-creation sites (2):**

- `createPaymentIntent` (`stripe.server.ts:41`) — spread `destinationParamsFor` into the
  create; stamp `payment_intent.stripe_account_id` + `application_fee_cents`. On a
  destination-specific create error: **catch → retry as platform charge**, `console.warn`
  (rule 12), fire-and-forget `syncAccountStatus` to re-true the stale flags. Call sites
  (`order/checkout.server.ts:190`, `app.checkout-test.tsx`) unchanged.
- `acp/charge.server.ts:32` — same spread + same stamping (agentic checkout parity).

**Routes:**

- `dashboard.api.billing.tsx` (new; pattern of `dashboard.api.integrations.tsx`) — loader:
  status DTO `{ connected, chargesEnabled, payoutsEnabled, detailsSubmitted, feeBps, feeFlatCents,
  balance?, expressDashboardUrl? }` (never leak the raw row). Action intents:
  `start-onboarding` → `{ url }`; `refresh-status` → re-sync + DTO.
- `dashboard.payouts.stripe.$.tsx` (new; splat precedent `auth.shippo.$.tsx`) — browser-facing
  `return` (sync status → redirect into Settings with status) and `refresh` (fresh account
  link → redirect to Stripe). Both require the dashboard session; build URLs from the
  existing app origin (`SHOPIFY_APP_URL` / request origin helper — locate at implement time).

**UI:** a **Payouts card inside `screens/Settings.tsx`** (where connectors already live):
not-connected → "Set up payouts" CTA; onboarding-incomplete → "Resume onboarding";
active → balance, fee line ("Platform fee: 0% — pilot"), "Open Stripe dashboard" login link.
`cd-*` primitives + `CDIcon` registry (Lucide) only. Promote to its own screen when fee
reporting / payout history lands. No embedded-admin mirror: the pivot retires the Polaris
surface, and billing is dashboard-native (parity rule satisfied on the one real surface).

**Env:** no new secrets in pilot — reuses `STRIPE_SECRET_KEY`. Fast-follow webhook adds
`STRIPE_CONNECT_WEBHOOK_SECRET` (+ `.env.example` entry then).

## 6. Status sync (pilot: pull, not push)

`account.updated` webhooks require a second, Connect-configured endpoint + secret. Pilot
skips it: flags re-sync (1) on the onboarding return URL, (2) on every Settings/billing
load, (3) via the explicit refresh intent, and (4) self-heal on destination-create failure.
With one pilot merchant this converges fast, and the checkout fallback makes stale flags
harmless (worst case: a charge lands on the platform → manual payout, i.e. today).
**Fast-follow:** `webhooks.stripe.connect.tsx` handling `account.updated` (+ later
`payout.paid/failed`), with a sibling idempotent recorder — `record_stripe_event` cannot be
reused as-is because it **raises when no `payment_intent` matches** (migration lines
103–105) and Connect account events carry no PI.

## 7. Error handling & invariants

- **Checkout never fails because of payout plumbing** — any destination-branch error falls
  back to a platform charge; the failure is logged, never swallowed silently (rule 12).
- **Never route to a half-onboarded account** — the three-flag gate; money either reaches a
  fully-enabled merchant account or stays platform-side where it's manually recoverable.
- **`paid` semantics unchanged** — order state still transitions only via
  `payment_intent.succeeded` through `record_stripe_event`; destination PIs carry the same
  `shop_id` / `order_ref` metadata.
- **Onboarding idempotent** — re-clicking the CTA reuses the existing `acct_...`; account
  links are safe to regenerate.
- **DTO boundary** — dashboard loader shapes a DTO; raw Stripe objects and DB rows never
  reach the client.

## 8. Interplay & deferred money bookkeeping

- **Refunds (spec #6, not yet built):** destination-charge refunds must pass
  `reverse_transfer: true` (and `refund_application_fee: true` once fees are non-zero).
  Operational note for pilot: a refund issued by hand in the *platform* Stripe dashboard must
  manually tick "reverse transfer", and a merchant cannot refund from their Express
  dashboard — pilot refunds are a Calderyn-operator action.
- **Ledger `'fee'` / `'payout'` emission — deferred** to the fee-on milestone:
  `application_fee.created` arrives on the **existing platform endpoint** (fees are platform
  objects) and can resolve its PI via `originating_transaction`; connected-account payout
  events need the fast-follow Connect endpoint. Until then the ledger keeps recording
  `'capture'` only — payout truth lives in Stripe, surfaced read-only via `getPayoutSnapshot`.
- **Disputes:** handled in the Stripe dashboard during pilot (platform bears destination-
  charge dispute liability); `charge.dispute.created` handling is out of scope.

## 9. Testing (behavioral)

Mirror `stripe.server.test.ts` / mocked-SDK conventions:

1. No connected row → platform PI (no `transfer_data`); **existing tests stay green**.
2. Row present but any gate flag false → platform PI.
3. Fully enabled → `transfer_data.destination` + `on_behalf_of` set; `application_fee_amount`
   **absent** at fee 0, **present and correct** at bps/flat combos (incl. clamp at `amount`,
   rounding).
4. Destination create error → fallback platform PI succeeds, warn logged, re-sync kicked.
5. `payment_intent` row stamped with `stripe_account_id` / `application_fee_cents` (null on
   platform charges).
6. `startOnboarding` idempotency — second call reuses `acct_...`, still returns a fresh link.
7. `syncAccountStatus` maps `accounts.retrieve` flags; sets `onboarded_at` once.
8. ACP charge path gets identical destination params (shared helper, not duplicated logic).
9. Billing loader DTO shape; action intents validated at the boundary (no trusted FormData).

## 10. Success criteria

- Merchant with no connected account: checkout + webhook + warehouse emit behave exactly as
  today (regression green).
- Pilot merchant completes Express onboarding from Settings; card flips to "Payouts active".
- Test-mode purchase: connected account receives full amount (fee 0), auto-payout scheduled,
  order reaches `paid`, `order_fact` emit unchanged, `payment_intent` row carries `acct_...`.
- Setting `application_fee_bps > 0` on the merchant's `stripe_connected_account` row makes the next PI carry the right
  `application_fee_amount` (test mode verified) with no code change.
- Full gate: `npm run typecheck` / `lint` / `build` / `prisma validate` (if touched) green.

## 11. Non-goals (this slice)

- Merchant SaaS subscription billing (old §#11 framing — superseded; revisit only if a
  flat-plan model is ever chosen over the transaction fee).
- Connect webhook endpoint / `account.updated` push sync (fast-follow, §6).
- Ledger `'fee'`/`'payout'` emission (fee-on milestone, §8).
- Dispute automation, payout-history mirroring (Express dashboard covers the merchant view).
- Cross-border / multi-currency (pilot: US, usd), Standard/Custom account types, and
  multi-merchant carts (would force separate charges & transfers).
- Feature-gating premium capability on billing state (meaningless while fee=0 comp).

## 12. Implementation deltas (review-hardened)

Applied after a max-effort code review of the built slice; supersede §5 where they differ:

- **One routing seam:** `createRoutedPaymentIntent(shopId, base, {logLabel})` in
  `connect.server.ts` owns decision + destination→platform fallback + stamp values;
  BOTH PI sites call it (no per-site fallback copies).
- **Narrow fallback guard:** only `StripeInvalidRequestError` with
  `code === 'account_invalid'` or `param` matching `transfer_data|on_behalf_of` falls
  back — an invalid request we caused propagates visibly (rule 12).
- **Fail-open reads:** `destinationParamsFor` catches its own connected-account read
  error → warn + platform decision, so §7's "checkout never fails because of payout
  plumbing" covers the lookup too.
- **ACP mirror insert checked:** a failed persist after a `confirm:true` charge throws
  (never a false success).
- **Login link on demand:** `expressDashboardUrl` REMOVED from the billing DTO; a
  `login-link` action intent mints the single-use link when clicked (was one wasted
  live Stripe call per Settings load, coupled to the balance read).
- **Onboarding legs hardened:** `return` degrades gracefully on a sync failure;
  `refresh` never CREATEs an account on GET (no row → redirect home).
- **Origin resolution:** skips empty-string envs, strips all trailing slashes.

## 13. Assumptions locked at review

Scope A (Connect + configurable fee, 0 in pilot); Express; destination charges;
`on_behalf_of = merchant`; fallback-to-platform for un-onboarded merchants; fee knob as
per-shop columns. Any of these can be reversed at spec review before planning.
