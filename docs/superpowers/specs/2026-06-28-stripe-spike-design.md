# Stripe Spike (Keepable Thin Slice) — Payments Round-Trip + Transaction Ledger

**Date:** 2026-06-28
**Status:** Design committed. One of three standalone modules in `feat/external-integrations`. ZERO dependency on teammate "John". Implements master pivot spec **#3** (Payments) as a keepable thin slice — nothing throwaway.
**Scope guard:** Implement to exactly this spec. The thin slice proves the Stripe round-trip AND lays the real `payment_intent` / `transaction_ledger` / `stripe_event` foundation. Everything past that (real order wiring, refunds, payouts, saved cards) is explicitly **Out of scope** below.

---

## What it is

**Net-new money movement, de-risked but permanent.** A test-mode checkout creates a Stripe **PaymentIntent**, renders it through the Stripe **Payment Element** so raw card data never touches Calderyn servers (PCI **SAQ-A**), and on Stripe's webhook confirmation writes an append-only **transaction_ledger** row and flips `payment_intent.status` to `succeeded`. The step that would set an order to `paid` is **STUBBED** (a log line) because the order state machine (master spec **#2**) does not exist yet.

The slice operates on `amount_cents` only — it has **no catalog dependency** (no `sku_dim` / pricing read) and **no order dependency** (order linkage is a nullable `order_ref` string). It de-risks Stripe (signature crypto, idempotency, PCI posture) while laying the exact tables and idempotency contract that #2 and #3-full will build on.

---

## Includes

- Real warehouse migrations (Supabase/postgres, **not** Prisma — payments are warehouse tables): `payment_intent`, `transaction_ledger` (append-only, signed amounts), `stripe_event` (unique Stripe event id, 23505-tolerant insert).
- Server lib `app/lib/payments/stripe.server.ts`: `createPaymentIntent(...)` — creates the Stripe PI, stamps tenant metadata, persists the shop-scoped `payment_intent` row, returns the client secret.
- Public webhook route `app/routes/webhooks.stripe.tsx`: verify Stripe signature → idempotent `stripe_event` insert → write `transaction_ledger` row + update `payment_intent.status` → (STUBBED) "would set order to paid". Idempotent under Stripe retries.
- A minimal **test-mode** checkout route rendering the Stripe Payment Element (hardcoded amount). Reused embedded-admin auth supplies `shop_id` for the spike — see `// ponytail` note; the real buyer checkout is the unauthenticated storefront (#7).
- `.env.example` updated with the three TEST-mode Stripe keys; secrets read from `process.env` server-side only.
- Tests: idempotency (same event twice → one ledger row), signature rejection, reconciliation (ledger sum == captured amount).

---

## Depends on

- **None from John.** Standalone in `feat/external-integrations`; no shared state with the other two integration modules.
- **Stubs into #2 (order state machine) later.** The "set order to paid" transition is a no-op log line today; `order_ref` is a nullable string. When #2 lands, `order_ref` graduates to an `order_id uuid` FK and the stub becomes the real `order.state = 'paid'` transition via #2's adapter.
- New top-level dependencies — see **New dependencies (flagged)**.

---

## New dependencies (flagged)

Per repo rule (no new top-level deps without flagging the tradeoff):

| Package | Side | Why (justification) | Tradeoff |
|---|---|---|---|
| `stripe` | server only (`.server.ts`) | Webhook **signature verification** (`stripe.webhooks.constructEvent`) and PaymentIntent ergonomics. Do **not** hand-roll the HMAC/timestamp signature crypto — getting it wrong is a spoofing/forgery surface. | Maintained by Stripe (first-party, MIT). Server-only so it never enters a client bundle. Single well-scoped dependency; low maintenance risk. |
| `@stripe/stripe-js` | client | Loads Stripe.js from Stripe's domain so the card iframe is served by Stripe (the mechanism that keeps us SAQ-A). | First-party, MIT, tiny loader shim; the heavy JS is fetched from Stripe's CDN, not bundled. |
| `@stripe/react-stripe-js` | client | React `<Elements>` / `<PaymentElement>` bindings for mounting the Payment Element. | First-party, MIT, thin React wrapper over stripe-js. No transitive bloat of note. |

All three are first-party Stripe packages under MIT, actively maintained. The `stripe` server SDK must never be imported from a client module (it carries the secret-key surface); the two `@stripe/*` packages are client-only and use the publishable key.

---

## Credentials needed

All **TEST mode** (`sk_test_…`, `pk_test_…`, `whsec_…`). Add to `.env.local` only (never `.env`, never source); mirror as placeholders in `.env.example`.

| Var | Side | Notes |
|---|---|---|
| `STRIPE_SECRET_KEY` | server only | `sk_test_…`. Read via `process.env` in `.server.ts` only. Never in a client bundle. |
| `STRIPE_WEBHOOK_SECRET` | server only | `whsec_…`. Printed by `stripe listen` (dev) or the Stripe dashboard endpoint (deployed). Used by `constructEvent`. |
| `STRIPE_PUBLISHABLE_KEY` | client-exposed | `pk_test_…`. **The only Stripe key allowed in the client bundle.** Passed from the loader to the Payment Element. |

`.env.local` must remain gitignored and uncommitted (already enforced). Update `.env.example` with the three keys + a one-line comment each (server-only for the first two; "client-exposed publishable key" for the third).

---

## Data model / contracts

Three new warehouse tables. Conventions match existing fact tables (`order_fact`, `refund_fact`, `ad_click_ref`): `uuid` PK via `gen_random_uuid()` (or `bigserial` for the append-only event log, mirroring `raw_shopify_webhook`), `shop_id uuid not null references public.shops(id) on delete cascade`, money as **integer cents**, RLS enabled + a `for select` read policy keyed on `current_shop_id()`. See the RLS reconciliation note in **Grounding**.

### `payment_intent`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid pk default gen_random_uuid()` | |
| `shop_id` | `uuid not null references public.shops(id) on delete cascade` | manual scoping; tenant owner |
| `stripe_pi_id` | `text not null` | Stripe `pi_…`. Lookup key the webhook joins on. |
| `order_ref` | `text` (nullable) | `// ponytail:` STUBBED order linkage. Upgrade path: becomes `order_id uuid references order(id)` when #2 lands. |
| `amount_cents` | `integer not null` | requested amount (integer cents, no float) |
| `currency` | `text not null` | lowercase ISO-4217 (Stripe convention), default `'usd'` |
| `status` | `text not null default 'requires_payment_method'` | mirrors Stripe PI status: `requires_payment_method` \| `processing` \| `succeeded` \| `canceled` \| `failed` |
| `created_at` | `timestamptz not null default now()` | |
| `updated_at` | `timestamptz not null default now()` | bumped on status change |
| | `unique (stripe_pi_id)` | one row per Stripe PI |

### `transaction_ledger` (append-only, signed)

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid pk default gen_random_uuid()` | |
| `shop_id` | `uuid not null references public.shops(id) on delete cascade` | shop-scoped (manual scoping on every read) |
| `payment_intent_id` | `uuid references public.payment_intent(id) on delete restrict` | `restrict` so a captured PI can't be deleted out from under its ledger |
| `order_ref` | `text` (nullable) | `// ponytail:` mirrors `payment_intent.order_ref`; → `order_id` FK in #2 |
| `kind` | `text not null check (kind in ('auth','capture','refund','fee','payout'))` | **only `'capture'` is emitted in this slice**; the others are the keepable enum for #3-full |
| `amount_cents` | `bigint not null` | **SIGNED**: capture positive; refund/fee/payout negative when they land |
| `currency` | `text not null` | |
| `stripe_ref` | `text not null` | the Stripe object that caused this entry (charge `ch_…` or `pi_…`) — for reconciliation |
| `stripe_event_id` | `text not null` | the `evt_…` that produced this row — ties ledger to the dedup table |
| `occurred_at` | `timestamptz not null` | Stripe event `created` time |
| `created_at` | `timestamptz not null default now()` | |
| | `unique (stripe_event_id, kind)` | **secondary** idempotency guard (defense-in-depth); the primary guard is `stripe_event` |

**Append-only is a hard invariant.** No `UPDATE`/`DELETE` on `transaction_ledger`. Corrections are new compensating rows (e.g. a negative `refund`), never edits. This is what makes the paid state auditable and is enforced by convention in the lib (no update path is written) — a DB-level revoke of `UPDATE`/`DELETE` from the service role is noted as a follow-up hardening (out of scope for the spike; flagged so it isn't forgotten).

### `stripe_event` (idempotency log — mirrors `raw_shopify_webhook`)

| Column | Type | Notes |
|---|---|---|
| `id` | `bigserial primary key` | mirrors `raw_shopify_webhook` |
| `shop_id` | `uuid not null references public.shops(id) on delete cascade` | resolved from PI metadata / the matching `payment_intent` row |
| `stripe_event_id` | `text not null` | Stripe `evt_…` (≈ `webhook_id`) |
| `type` | `text not null` | event type, e.g. `'payment_intent.succeeded'` (≈ `topic`) |
| `signature_verified` | `boolean not null` | (≈ `hmac_verified`) |
| `received_at` | `timestamptz not null default now()` | |
| `payload` | `jsonb not null` | raw event |
| | `unique (stripe_event_id)` | **primary idempotency key** — exactly mirrors `raw_shopify_webhook.unique(webhook_id)` |

### `createPaymentIntent` signature

```
createPaymentIntent(
  shopId: string,
  amountCents: number,
  currency: string,
  orderRef?: string,
): Promise<{ paymentIntentId: string; clientSecret: string; amountCents: number; currency: string }>
```

- **Decided (rule 7):** the leading `shopId` stays → `createPaymentIntent(shopId, amountCents, currency, orderRef?)`. `payment_intent` is shop-scoped and the warehouse has **no RLS to infer the tenant** on the service-role write path — the function must be told which shop owns the row. The alternative (split persistence into the route) is rejected because it scatters the keepable table-write away from the lib.
- Behavior: validate `amountCents` is a positive integer and `currency` is a known 3-letter code at the boundary (never trust callers); create the Stripe PI with `automatic_payment_methods` enabled and `metadata: { shop_id: shopId, order_ref: orderRef ?? '' }`; insert the `payment_intent` row (status from the PI); return `{ paymentIntentId, clientSecret, … }`. The `clientSecret` is handed to the Payment Element.
- No float math anywhere — cents in, cents out, matching the repo's `parseRateToCents` discipline.

### Webhook event → ledger mapping

The webhook handles **`payment_intent.succeeded`** (capture) and **`payment_intent.payment_failed`** (failure). **Decided:** these are the correct events for the PaymentIntent + Payment Element flow and supersede the master spec's loose mention of `charge.succeeded`; the charge id used for `stripe_ref` is read from the PI's `latest_charge` (falling back to the `pi_…` id).

| Stripe event | Ledger write | `payment_intent.status` | Stubbed order step |
|---|---|---|---|
| `payment_intent.succeeded` | one `transaction_ledger` row: `kind='capture'`, `amount_cents = +amount_received`, `stripe_ref = charge/pi id`, `stripe_event_id = evt`, `occurred_at = event.created` | → `succeeded` | log `"would set order <order_ref> to paid"` — **no-op until #2** |
| `payment_intent.payment_failed` | **none** (no money moved → no ledger row; keeps reconciliation exact) | → `failed` | — |
| any other event type | none | unchanged | acknowledge with 200 (so Stripe stops retrying), do nothing |

**Money moves → ledger row. No money → no ledger row.** A failed payment only updates status. This is what lets "sum of ledger == Stripe captured amount" hold exactly (rule 12).

### Idempotency mechanism (the load-bearing contract)

Mirrors the `raw_shopify_webhook` 23505-tolerant pattern, made atomic for the multi-table payment write:

1. **Verify signature** with `stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET)`. On failure → **400**, write nothing.
2. **Validate event shape** at the boundary (event id, type, `data.object`) — never trust the payload.
3. **Atomic record-or-skip** via a single Postgres function invoked with `supabase.rpc(...)` (one SQL function = one transaction): `insert into stripe_event (...) ... on conflict (stripe_event_id) do nothing`. If a row was inserted (first delivery), within the **same transaction** write the `transaction_ledger` row and update `payment_intent.status`. If the insert hit the unique constraint (**23505** / `on conflict`), the function is a **no-op** and reports "already processed".
   - Atomicity is required, not optional: if the event marker and the ledger row could land in separate transactions, a crash between them either double-writes the ledger on retry or strands a marker with no ledger row — exactly the corruption rule 12 forbids. The single RPC closes that window. (App-ordered `supabase-js` calls are explicitly rejected for this reason.)
4. **Return 200** in both the first-delivery and already-processed cases (so Stripe stops retrying a successfully-handled event).

Idempotency therefore rests on **`stripe_event.unique(stripe_event_id)`** (primary), with **`transaction_ledger.unique(stripe_event_id, kind)`** as a secondary guard. Stripe retries and at-least-once delivery yield exactly **one** ledger row per event.

---

## Grounding (EXISTS vs NET-NEW)

**NET-NEW — confirmed absent today:**
- No payment / Stripe / transaction / payout surface anywhere. `grep -riE "payment_intent|stripe|transaction_ledger|payout"` over `supabase/migrations/` and `tests/engine/schema/` returns **nothing** (exit 1); no `stripe`/`paymentintent` references under `app/`. This module is the first money rail.
- Master spec **#3** describes this module: `docs/superpowers/specs/2026-06-27-calderyn-platform-pivot-design.md:422-446` (What it is, Includes, Data model, Risks). The "set order to paid" step stubs into **#2** (order state machine): same file, `:367-391`.

**EXISTS — patterns this slice mirrors (do not reinvent):**
- **Idempotency pattern (the one to copy):** the 23505-tolerant insert lives at `app/lib/calderyn.server.ts:2011-2020` (`internal.forwardWebhook` → `raw_shopify_webhook`; comment: *"23505 = unique(webhook_id): Shopify redelivered something that already landed — the delivery IS persisted, so that's success."*). **Note:** the master spec cites this as `calderyn.server.ts:1970-1979`; the verified current location is **2011-2020** (the file has shifted). The unique constraint it relies on is `unique (webhook_id)` at `tests/engine/schema/migrations/20260419000004_create_raw_shopify_webhook.sql:10`. The 23505 branch idiom also appears in `app/lib/actions/autopilot-lock.server.ts:82-84`.
- **Warehouse table conventions:** `refund_fact` (`tests/engine/schema/migrations/20260616160000_refunds.sql`) and `order_fact` (`.../20260426000003_orders_and_fulfillments.sql:4-31`) — `uuid` PK, `shop_id … references public.shops(id) on delete cascade`, integer-cents money columns, `unique (shop_id, …)` idempotency keys, `enable row level security` + `create policy … for select using (shop_id = public.current_shop_id())`.
- **Where warehouse migrations live:** the canonical/live migrations are in **`supabase/migrations/`** (applied to live Supabase via the app's migration tooling). A mirrored copy of base fact-table DDL also lives in **`tests/engine/schema/migrations/`** (the engine repo's schema, kept in sync — see the in-file note in `20260616160000_refunds.sql`: *"base fact tables in this repo are owned by the engine repo's schema; this file is the canonical mirror … keep the two in sync."*). The payment tables are **app-owned, not engine-owned**. **Decided:** they land in `supabase/migrations/` ONLY — the Python engine does not read them, so no `tests/engine/schema/migrations/` mirror copy is created.
- **RLS reconciliation (rule 7 — surface, don't average):** the task convention states *"warehouse has NO Postgres RLS — manual `shop_id` scoping."* The actual fact tables **do** `enable row level security` and add a `for select using (shop_id = current_shop_id())` read policy. These reconcile: the **writer uses the service-role key, which bypasses RLS** (so all payment writes and most server reads run RLS-free), and the real tenant guard on the service-role path is a **mandatory `.eq('shop_id', shopId)` on every `transaction_ledger`/`payment_intent` read**. **Decided:** **mirror `refund_fact` exactly** — `enable row level security` + a `for select using (shop_id = public.current_shop_id())` read policy on all three payment tables (Supabase-advisor / defense-in-depth) — while treating manual `shop_id` scoping on the service-role path as the load-bearing guard. This resolves the master-spec "no RLS" vs. newer-tables conflict in favor of the hardened pattern for money data.

---

## Security / PCI

- **PCI SAQ-A.** Raw card data (PAN) is entered into a Stripe-hosted iframe served by Stripe.js (`@stripe/stripe-js` loads from Stripe's domain). Card data never hits Calderyn servers or our bundle — we only ever see a `pi_…` id and a `client_secret`. This is the entire reason for the Payment Element; **do not** add a custom card form or proxy card fields, which would escalate PCI scope.
- **Signature verification is mandatory and exact.** The webhook is a public endpoint; it must `constructEvent` with `STRIPE_WEBHOOK_SECRET` against the **raw** request body before any parsing or DB write. A verification failure returns 400 and writes nothing. Do not hand-roll the signature crypto — that is the justification for the `stripe` SDK.
- **Secret handling.** `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are server-only (`process.env` inside `.server.ts`); they must never appear in a client bundle. `STRIPE_PUBLISHABLE_KEY` is the only key passed to the client. The `verify-client-bundle` scan must stay green — if it flags a key, remove the leak, don't weaken the verifier.
- **Tenant isolation.** No RLS enforcement on the service-role write path → every ledger/intent query carries an explicit `shop_id`. The webhook resolves `shop_id` from PI metadata and cross-checks it against the matching `payment_intent` row before writing.
- **Fail visibly (rule 12).** Never set `payment_intent.status='succeeded'` (and, later, never set an order `paid`) for an event that cannot be tied to a captured Stripe charge. The ledger is append-only and must reconcile to Stripe exactly.

---

## MVP rationale

"A real buyer completes a real, PAID purchase" is the literal MVP gate, and payment capture is its definition. This slice proves the full Stripe round-trip (create → confirm in Payment Element → webhook → ledger) and lays the **keepable** `payment_intent` / `transaction_ledger` / `stripe_event` tables plus the idempotency contract — so when #2 (orders) lands, the only new work is replacing the stubbed `order_ref` with a real `order_id` FK and the log line with the real `paid` transition. Nothing here is throwaway. It is deliberately the thinnest slice that does this: `amount_cents` only, no catalog, no real order, hardcoded test amount.

---

## Risks

- **PCI scope creep.** Any deviation from Elements/PaymentIntents (a custom card field, logging a token, proxying card data) silently escalates compliance from SAQ-A. Mitigation: Payment Element only; no card data path through our code.
- **Ledger must reconcile to Stripe exactly.** A double-write or a missed/duplicated event corrupts the financial source of truth. Mitigation: atomic record-or-skip RPC; ledger rows only for money-moving events; `unique(stripe_event_id)` primary + `unique(stripe_event_id, kind)` secondary; append-only (no edits/deletes).
- **Idempotency / out-of-order / duplicate events.** Stripe delivers at-least-once and can reorder. Mitigation: the dedup table + atomic transaction make replays no-ops; status transitions are derived from event type, not assumed ordering.
- **Stubbed order linkage.** `order_ref` is a nullable string and the "set order paid" step is a log line until #2. Risk: the stub is mistaken for a real wiring. Mitigation: explicit `// ponytail:` markers in code + this spec; upgrade path documented (→ `order_id` FK, real transition via #2's adapter).
- **Test-mode checkout reuses admin auth.** The spike checkout is embedded-admin-gated to borrow `shop_id`; the real buyer checkout is the unauthenticated storefront (#7). Risk: shipping the admin-gated checkout as if it were production. Mitigation: `// ponytail:` marker + Out-of-scope note; it is a spike harness, not the buyer surface.

---

## Out of scope

- **Refunds (#3b)** — the `refund` ledger kind exists in the enum but is not emitted; no refund flow, no `charge.refunded` handling.
- **Payouts** — `payout`/`fee` kinds reserved in the enum; no payout reconciliation.
- **Real order wiring (#2)** — order state machine, `cart`/`checkout_session`/`order` tables, and the real `paid` transition. The spike only logs the stub.
- **Buyer saved cards / off-session reuse (#1b)** — no Customer object, no SetupIntent, no stored payment methods.
- **Unauthenticated storefront checkout (#7)** — the real buyer-facing checkout surface and shop resolution from host/subdomain.
- **Multi-currency UX, payment-failure/retry UX, capture-vs-authorize policy, Apple/Google Pay tuning** — the slice uses immediate capture (`automatic_payment_methods`) and a single hardcoded amount.
- **DB-level `UPDATE`/`DELETE` revoke on `transaction_ledger`** — append-only is enforced by convention in the lib for the spike; the hard revoke is a noted follow-up hardening.
- **Dashboard parity.** `TODO(parity)`: this is backend lib + a spike harness with **no merchant-facing dashboard UI yet**, so there is nothing to mirror into the dashboard surface this round. When #3 graduates to a real feature (payments status, transaction history, reconciliation view), the dashboard mirror becomes in-scope and must be implemented as part of that change — stated here explicitly so it is **not silently skipped**.

---

## Verification & success criteria

Concrete, runnable checks. All must pass before the slice is considered done (rule 4, rule 12 — evidence, not assertion).

**Manual round-trip (Stripe CLI):**
1. `stripe login`, then `stripe listen --forward-to localhost:<port>/webhooks/stripe`. Copy the printed `whsec_…` into `STRIPE_WEBHOOK_SECRET` (`.env.local`).
2. Open the test checkout, pay with test card `4242 4242 4242 4242` (any future expiry / CVC). Expect: PI succeeds → Stripe sends `payment_intent.succeeded` → **exactly one** `transaction_ledger` row (`kind='capture'`, positive `amount_cents`), `payment_intent.status='succeeded'`, and a log line `"would set order … to paid"`.
3. `stripe trigger payment_intent.succeeded` → produces **exactly one** ledger row. Re-delivering the **same** event id (Stripe's resend, or replaying the captured payload) adds **no** second row.

**Automated:**
4. **Idempotency unit test:** deliver the same webhook event payload twice (same `evt_` id, valid signature) → assert **exactly one** `transaction_ledger` row **and one** `stripe_event` row; the second delivery returns **200** and is a no-op (the 23505 / `on conflict` path).
5. **Signature-rejection test:** a request with an invalid/missing signature → **400**, with **zero** `stripe_event` rows and **zero** ledger rows written.
6. **Reconciliation test:** `sum(transaction_ledger.amount_cents)` for a PI **equals** Stripe's captured amount for that PI (no float drift, signed correctly).
7. **Pre-commit gate:** `npm run typecheck` → 0, `npm run lint` → 0 (no new warnings), `npm run build` → 0, `npx prisma validate` if any Prisma schema changed (none expected — these are warehouse tables). `verify-client-bundle` green (no secret key in the bundle; only `pk_test_…` client-side).

**Success = ** one PaymentIntent created → paid in the Payment Element → exactly one capture ledger row → status `succeeded` → reconciles to Stripe → replays are no-ops → no card data and no secret key ever reach the client.

---

## Decisions (resolved)

The five items raised during grounding are now resolved and baked into the sections above:

1. **`createPaymentIntent` signature:** keep the leading `shopId` → `createPaymentIntent(shopId, amountCents, currency, orderRef?)`. The ledger is shop-scoped and the service-role write path has no RLS-inferred tenant, so the function must be told which shop owns the row.
2. **RLS posture:** payment tables (`payment_intent`, `transaction_ledger`, `stripe_event`) `enable row level security` + a `for select using (shop_id = public.current_shop_id())` read policy + service-role bypass, mirroring `refund_fact`. Hardened pattern for money data; manual `shop_id` scoping on the service-role path remains the load-bearing guard. (Resolves the master-spec "no RLS" vs. newer-tables conflict in favor of the hardened pattern.)
3. **Migration location:** `supabase/migrations/` ONLY. App-owned tables, not read by the Python engine → no `tests/engine/schema/migrations/` mirror copy.
4. **Capture event:** handle `payment_intent.succeeded` (capture) and `payment_intent.payment_failed` (failure) — correct for the PaymentIntent + Payment Element flow; supersedes the master spec's loose `charge.succeeded`. `stripe_ref` takes the charge id from the PI's `latest_charge`.
5. **Stubbed paid step:** a structured log line only (`"would set order … to paid"`) — a no-op until #2 (order state machine) lands; there is no order table to write yet.
