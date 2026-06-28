# Stripe Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the full Stripe test-mode round-trip (create PaymentIntent → pay in the Payment Element → verified webhook → exactly one append-only capture ledger row) on top of the keepable `payment_intent` / `transaction_ledger` / `stripe_event` warehouse tables.

**Architecture:** A test-mode checkout creates a Stripe PaymentIntent via a server-only lib (`stripe.server.ts`) and persists a shop-scoped `payment_intent` row; the Stripe Payment Element (served from Stripe's domain, PCI SAQ-A) collects card data so it never touches our servers. On Stripe's webhook, we verify the signature with the SDK, then an **atomic** Postgres function records the event (`stripe_event.unique(stripe_event_id)`, on-conflict do nothing), writes one signed `transaction_ledger` row, and bumps `payment_intent.status` — all in one transaction so Stripe retries are exact no-ops. The "set order to paid" step is a log-only stub until the order state machine (#2) exists.

**Tech Stack:** Remix (Vite) + TypeScript (strict), Supabase/postgres warehouse (service-role client, RLS mirrored from `refund_fact`), Vitest, `stripe` server SDK (signature verification + PaymentIntents), `@stripe/stripe-js` + `@stripe/react-stripe-js` (client Payment Element, publishable key only).

> **Worktree:** all work happens in the `feat/external-integrations` worktree, created at execution time via superpowers:using-git-worktrees (e.g. `git worktree add ../calderyn-external-integrations -b feat/external-integrations`). Do **not** work on `main`. This Stripe spike is one of three standalone modules in that branch with zero shared state.

---

## File Structure

| File | Single responsibility |
|---|---|
| `supabase/migrations/20260628120000_stripe_payments.sql` | The 3 warehouse tables (`payment_intent`, `transaction_ledger`, `stripe_event`) + RLS (enable + `current_shop_id()` read policy, mirroring `refund_fact`) + the atomic `record_stripe_event(...)` Postgres function. App-owned; `supabase/migrations/` only (no engine mirror). |
| `app/lib/payments/stripe.server.ts` | Server-only Stripe lib: `getStripe()` (SDK singleton), `createPaymentIntent(shopId, amountCents, currency, orderRef?)` (creates PI + persists `payment_intent`), `processStripeEvent(rawBody, signature)` (verify signature → atomic record-or-skip rpc → ledger + status). Never imported from a client module. |
| `app/routes/webhooks.stripe.tsx` | Public, unauthenticated webhook resource route. Reads the **raw** body + `stripe-signature` header, delegates to `processStripeEvent`, returns 200 on success/duplicate, 400 on bad signature. |
| `app/routes/app.checkout-test.tsx` | Embedded-admin test-mode checkout harness. Loader exposes only the publishable key; action creates the PI (hardcoded amount); component mounts `<Elements>`/`<PaymentElement>`. `// ponytail:` borrows admin auth for `shop_id`. |
| `app/lib/payments/stripe.server.test.ts` | Vitest unit tests: `createPaymentIntent` (PI create + row persist + boundary validation), `processStripeEvent` idempotency (same event twice → one ledger row), signature rejection (→ 400, nothing written), failed-event-writes-no-ledger. Mocks the Stripe SDK + `~/lib/supabase.server`. |
| `.env.local` / `.env.example` | The three TEST-mode Stripe keys (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` server-only; `STRIPE_PUBLISHABLE_KEY` client-exposed). |

**Consistent identifiers across all tasks:**
- Tables: `payment_intent`, `transaction_ledger`, `stripe_event`.
- `payment_intent` columns: `id, shop_id, stripe_pi_id, order_ref, amount_cents (integer), currency, status, created_at, updated_at`; `unique (stripe_pi_id)`.
- `transaction_ledger` columns: `id, shop_id, payment_intent_id, order_ref, kind, amount_cents (bigint signed), currency, stripe_ref, stripe_event_id, occurred_at, created_at`; `unique (stripe_event_id, kind)`; `kind in ('auth','capture','refund','fee','payout')`.
- `stripe_event` columns: `id (bigserial), shop_id, stripe_event_id, type, signature_verified, received_at, payload (jsonb)`; `unique (stripe_event_id)`.
- RPC: `public.record_stripe_event(...)` returns `boolean` (`true` = first delivery / processed, `false` = duplicate / no-op).
- Lib signature: `createPaymentIntent(shopId: string, amountCents: number, currency: string, orderRef?: string)`.
- Test command (single file): `npx vitest run app/lib/payments/stripe.server.test.ts`. Full suite: `npm run test`.

---

## SECURITY (do not simplify away)

These constraints are load-bearing. Any step that weakens one is a failure, not a shortcut.

- **Stripe signature verification via the SDK — never hand-roll.** `processStripeEvent` calls `getStripe().webhooks.constructEvent(rawBody, signature, STRIPE_WEBHOOK_SECRET)` over the **raw** request bytes before any parse or DB write. Failure → return 400, write nothing. The HMAC/timestamp crypto is the whole reason the `stripe` SDK is a dependency.
- **PCI SAQ-A.** Card data (PAN) is entered only in the Stripe-hosted Payment Element iframe (loaded from Stripe's domain by `@stripe/stripe-js`). It never reaches our server or our bundle — we only ever see `pi_…` ids and a `client_secret`. Do NOT add a custom card form or proxy card fields.
- **Secrets server-side only.** `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are read via `process.env` inside `.server.ts` only; the `stripe` SDK is imported only from `stripe.server.ts`. `STRIPE_PUBLISHABLE_KEY` (`pk_test_…`) is the **sole** Stripe key allowed client-side. `npm run build` runs `verify:client-bundle`; keep it green by never importing server modules client-side (do not weaken the verifier).
- **Money as integer cents.** No float math anywhere. `amount_cents` is `integer` on `payment_intent`, `bigint` (signed) on `transaction_ledger`. Capture is positive.
- **Ledger is append-only.** No `UPDATE`/`DELETE` path is written in the lib; corrections are new compensating rows. (DB-level revoke of `UPDATE`/`DELETE` is a noted follow-up, out of scope for the spike.)
- **Fail visibly (rule 12).** Never write a `capture` ledger row or set `status='succeeded'` for an event that cannot be tied to a verified Stripe event AND a matching shop-scoped `payment_intent`. The `record_stripe_event` function raises (rolling back the event marker) if the PI/shop can't be resolved.

**Deliberate simplifications (marked `// ponytail:` in code, with upgrade path):**
- Stubbed order linkage: `order_ref` is a nullable string; the "set order to paid" step is a `console.info` log. Upgrade: `order_ref` → `order_id uuid` FK + real transition via #2's adapter when the order state machine lands.
- Single capture kind: only `'capture'` is emitted; `auth`/`refund`/`fee`/`payout` are reserved enum values for #3-full.
- Test checkout reuses embedded-admin auth to borrow `shop_id`. Upgrade: the real buyer checkout is the unauthenticated storefront (#7), resolving shop from host/subdomain.

---

### Task 1: Install Stripe dependencies + add TEST-mode env vars

**Files:**
- Modify: `package.json` (via `npm install`)
- Modify: `.env.local`, `.env.example`

- [ ] **Step 1: Write the failing test** — confirm the deps are absent and env keys are unset (this is the "red" state):
  ```bash
  node -e "require('stripe')" ; echo "stripe exit=$?"
  grep -q "STRIPE_SECRET_KEY" .env.example && echo "FOUND" || echo "MISSING"
  ```
- [ ] **Step 2: Run to verify it fails** (Run: the two commands above) Expected: FAIL — `node -e "require('stripe')"` errors `Cannot find module 'stripe'` (non-zero exit); grep prints `MISSING`.
- [ ] **Step 3: Write minimal implementation** — install the three first-party Stripe packages (server SDK + client Element bindings), then add the env keys.
  ```bash
  npm install stripe @stripe/stripe-js @stripe/react-stripe-js
  ```
  Append to `.env.example` (placeholders only — real values go in `.env.local`):
  ```bash
  # === Stripe (TEST mode — payments spike) ===
  # Server-only secret key (sk_test_...). Read via process.env in *.server.ts only; never in a client bundle.
  STRIPE_SECRET_KEY=
  # Server-only webhook signing secret (whsec_...). Printed by `stripe listen` (dev) or the dashboard endpoint.
  STRIPE_WEBHOOK_SECRET=
  # Client-exposed publishable key (pk_test_...). The ONLY Stripe key allowed in the browser bundle.
  STRIPE_PUBLISHABLE_KEY=
  ```
  Add the same three keys with real `sk_test_…` / `whsec_…` / `pk_test_…` TEST values to `.env.local` (gitignored; never committed). Get them from the Stripe dashboard (Developers → API keys, test mode); `STRIPE_WEBHOOK_SECRET` comes from `stripe listen` in the Verification task.
- [ ] **Step 4: Run to verify it passes**
  ```bash
  npm ls stripe @stripe/stripe-js @stripe/react-stripe-js && npm run typecheck && grep -c "STRIPE_" .env.example
  ```
  Expected: PASS — all three packages resolve, `tsc --noEmit` exits 0, grep prints `3`.
- [ ] **Step 5: Commit**
  ```bash
  git add package.json package-lock.json .env.example && git commit -m "lib/payments: add Stripe deps + TEST-mode env keys"
  ```
  (Do NOT `git add .env.local` — it is gitignored and must never be committed.)

---

### Task 2: Migration — `payment_intent` / `transaction_ledger` / `stripe_event` + RLS + atomic record-or-skip function

**Files:**
- Create: `supabase/migrations/20260628120000_stripe_payments.sql`

- [ ] **Step 1: Write the failing test** — a check that the tables do not yet exist. Using the Supabase MCP against a **development branch** (or `supabase db reset` on a local stack), run:
  ```sql
  select count(*) from public.payment_intent;
  ```
  (Invoke via `mcp__plugin_supabase_supabase__execute_sql` with that query, or `supabase db query` locally.)
- [ ] **Step 2: Run test to verify it fails** (Run: the `execute_sql` above) Expected: FAIL — error `relation "public.payment_intent" does not exist`.
- [ ] **Step 3: Write minimal implementation** — create `supabase/migrations/20260628120000_stripe_payments.sql` with the full DDL. RLS mirrors `refund_fact` exactly (enable RLS + `for select using (shop_id = public.current_shop_id())`); the service-role writer bypasses RLS and uses explicit `shop_id` scoping as the load-bearing guard.
  ```sql
  -- Stripe payments spike (keepable thin slice): payment_intent + append-only
  -- transaction_ledger + stripe_event idempotency log. App-owned warehouse tables
  -- (not read by the Python engine -> supabase/migrations only, no engine mirror).
  -- Money is integer cents. RLS mirrors refund_fact: service-role writes bypass RLS;
  -- a current_shop_id() read policy is defense-in-depth for the authenticated path.

  -- 1) payment_intent: one row per Stripe PaymentIntent, shop-scoped.
  create table public.payment_intent (
    id           uuid primary key default gen_random_uuid(),
    shop_id      uuid not null references public.shops(id) on delete cascade,
    stripe_pi_id text not null,
    order_ref    text,                       -- ponytail: stubbed order linkage -> order_id FK in #2
    amount_cents integer not null,
    currency     text not null default 'usd',
    status       text not null default 'requires_payment_method',
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now(),
    unique (stripe_pi_id)
  );
  create index payment_intent_shop_idx on public.payment_intent (shop_id, created_at desc);

  alter table public.payment_intent enable row level security;
  create policy payment_intent_read on public.payment_intent
    for select using (shop_id = public.current_shop_id());

  -- 2) transaction_ledger: append-only, signed amounts. Only 'capture' emitted in this slice.
  create table public.transaction_ledger (
    id                uuid primary key default gen_random_uuid(),
    shop_id           uuid not null references public.shops(id) on delete cascade,
    payment_intent_id uuid references public.payment_intent(id) on delete restrict,
    order_ref         text,                  -- ponytail: mirrors payment_intent.order_ref -> order_id in #2
    kind              text not null check (kind in ('auth','capture','refund','fee','payout')),
    amount_cents      bigint not null,       -- SIGNED: capture positive; refund/fee/payout negative when they land
    currency          text not null,
    stripe_ref        text not null,         -- charge ch_... or pi_... that caused this entry
    stripe_event_id   text not null,         -- evt_... that produced this row
    occurred_at       timestamptz not null,  -- Stripe event.created
    created_at        timestamptz not null default now(),
    unique (stripe_event_id, kind)           -- secondary idempotency guard (defense-in-depth)
  );
  create index transaction_ledger_pi_idx on public.transaction_ledger (payment_intent_id);

  alter table public.transaction_ledger enable row level security;
  create policy transaction_ledger_read on public.transaction_ledger
    for select using (shop_id = public.current_shop_id());

  -- 3) stripe_event: idempotency log, mirrors raw_shopify_webhook.unique(webhook_id).
  create table public.stripe_event (
    id                 bigserial primary key,
    shop_id            uuid not null references public.shops(id) on delete cascade,
    stripe_event_id    text not null,
    type               text not null,
    signature_verified boolean not null,
    received_at        timestamptz not null default now(),
    payload            jsonb not null,
    unique (stripe_event_id)                 -- PRIMARY idempotency key
  );

  alter table public.stripe_event enable row level security;
  create policy stripe_event_read on public.stripe_event
    for select using (shop_id = public.current_shop_id());

  -- 4) Atomic record-or-skip: one SQL function = one transaction. Mirrors the
  -- raw_shopify_webhook 23505-tolerant pattern, made atomic for the multi-table write.
  -- Returns true on first delivery (event recorded + side effects applied),
  -- false on a duplicate (whole call is a no-op). Raises (rolling back the event
  -- marker) if the PI/shop can't be resolved -> fail visibly (rule 12).
  create or replace function public.record_stripe_event(
    p_event_id           text,
    p_type               text,
    p_shop_id            uuid,
    p_signature_verified boolean,
    p_payload            jsonb,
    p_stripe_pi_id       text,
    p_new_status         text,
    p_kind               text,        -- 'capture' for succeeded; null for failed/no-money events
    p_amount_cents       bigint,      -- ledger amount; null when no ledger row
    p_currency           text,
    p_stripe_ref         text,
    p_occurred_at        timestamptz
  ) returns boolean
  language plpgsql
  security definer
  set search_path = public
  as $$
  declare
    v_pi_id uuid;
  begin
    insert into public.stripe_event (shop_id, stripe_event_id, type, signature_verified, payload)
    values (p_shop_id, p_event_id, p_type, p_signature_verified, p_payload)
    on conflict (stripe_event_id) do nothing;

    -- 23505 / on-conflict: this event already landed -> the whole call is a no-op.
    if not found then
      return false;
    end if;

    -- First delivery: resolve the shop-scoped PI and cross-check the tenant.
    select id into v_pi_id
    from public.payment_intent
    where stripe_pi_id = p_stripe_pi_id and shop_id = p_shop_id;

    if v_pi_id is null then
      raise exception 'payment_intent % not found for shop %', p_stripe_pi_id, p_shop_id;
    end if;

    -- Money moved -> append exactly one ledger row (idempotent on retry via the unique guard).
    if p_kind is not null then
      insert into public.transaction_ledger (
        shop_id, payment_intent_id, order_ref, kind, amount_cents, currency,
        stripe_ref, stripe_event_id, occurred_at
      )
      select p_shop_id, v_pi_id, pi.order_ref, p_kind, p_amount_cents, p_currency,
             p_stripe_ref, p_event_id, p_occurred_at
      from public.payment_intent pi
      where pi.id = v_pi_id
      on conflict (stripe_event_id, kind) do nothing;
    end if;

    update public.payment_intent
    set status = p_new_status, updated_at = now()
    where id = v_pi_id;

    return true;
  end;
  $$;

  -- Money mutation: only the service role may call it (mirrors revoke_anon_rpc_execute hardening).
  revoke execute on function public.record_stripe_event(
    text, text, uuid, boolean, jsonb, text, text, text, bigint, text, text, timestamptz
  ) from public, anon, authenticated;
  ```
  Apply it: invoke `mcp__plugin_supabase_supabase__apply_migration` with `name` = `stripe_payments` and `query` = the SQL above, against a **development branch first** (never prod without explicit go-ahead). Locally: `supabase db reset` picks it up from `supabase/migrations/`.
- [ ] **Step 4: Run test to verify it passes** — re-run the existence check plus an RLS/advisor check:
  ```sql
  select count(*) from public.payment_intent;
  select count(*) from public.transaction_ledger;
  select count(*) from public.stripe_event;
  select relname, relrowsecurity from pg_class
   where relname in ('payment_intent','transaction_ledger','stripe_event');
  ```
  (via `execute_sql`), then `mcp__plugin_supabase_supabase__get_advisors` with `type` = `security`. Expected: PASS — all three `select count(*)` return `0` (tables exist, empty), `relrowsecurity` is `true` for all three, and the security advisor reports no "RLS disabled" finding for the new tables.
- [ ] **Step 5: Commit**
  ```bash
  git add supabase/migrations/20260628120000_stripe_payments.sql && git commit -m "supabase/migrations: stripe payment_intent + transaction_ledger + stripe_event (RLS + atomic record_stripe_event)"
  ```

---

### Task 3: `createPaymentIntent(shopId, amountCents, currency, orderRef?)`

**Files:**
- Create: `app/lib/payments/stripe.server.ts`
- Test: `app/lib/payments/stripe.server.test.ts`

- [ ] **Step 1: Write the failing test** — create `app/lib/payments/stripe.server.test.ts`. Mock the Stripe SDK and the Supabase client; assert the PI is created with the right params, the `payment_intent` row is persisted, and boundary validation rejects bad input.
  ```ts
  import { describe, it, expect, beforeEach, vi } from "vitest";

  // Hoisted mock handles shared by the Stripe SDK + Supabase mocks below.
  const h = vi.hoisted(() => ({
    piCreate: vi.fn(),
    constructEvent: vi.fn(),
    insert: vi.fn(),
    rpc: vi.fn(),
  }));

  // Server SDK: default export is the Stripe class; instances expose paymentIntents + webhooks.
  vi.mock("stripe", () => ({
    default: class {
      paymentIntents = { create: h.piCreate };
      webhooks = { constructEvent: h.constructEvent };
    },
  }));

  // Service-role Supabase client.
  vi.mock("~/lib/supabase.server", () => ({
    getSupabase: () => ({
      from: () => ({ insert: h.insert }),
      rpc: h.rpc,
    }),
  }));

  import { createPaymentIntent } from "./stripe.server";

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  });

  describe("createPaymentIntent", () => {
    it("creates a Stripe PI, persists the shop-scoped row, and returns the client secret", async () => {
      h.piCreate.mockResolvedValue({
        id: "pi_1",
        client_secret: "pi_1_secret_abc",
        status: "requires_payment_method",
      });
      h.insert.mockResolvedValue({ error: null });

      const out = await createPaymentIntent("shop-1", 2500, "USD", "order-1");

      expect(h.piCreate).toHaveBeenCalledWith({
        amount: 2500,
        currency: "usd",
        automatic_payment_methods: { enabled: true },
        metadata: { shop_id: "shop-1", order_ref: "order-1" },
      });
      expect(h.insert).toHaveBeenCalledWith({
        shop_id: "shop-1",
        stripe_pi_id: "pi_1",
        order_ref: "order-1",
        amount_cents: 2500,
        currency: "usd",
        status: "requires_payment_method",
      });
      expect(out).toEqual({
        paymentIntentId: "pi_1",
        clientSecret: "pi_1_secret_abc",
        amountCents: 2500,
        currency: "usd",
      });
    });

    it("rejects non-integer / non-positive amounts and unknown currencies at the boundary", async () => {
      await expect(createPaymentIntent("shop-1", -1, "usd")).rejects.toThrow();
      await expect(createPaymentIntent("shop-1", 12.5, "usd")).rejects.toThrow();
      await expect(createPaymentIntent("shop-1", 2500, "xyz")).rejects.toThrow();
      expect(h.piCreate).not.toHaveBeenCalled();
    });
  });
  ```
- [ ] **Step 2: Run test to verify it fails** (Run: `npx vitest run app/lib/payments/stripe.server.test.ts`) Expected: FAIL — `Cannot find module './stripe.server'` (the lib does not exist yet).
- [ ] **Step 3: Write minimal implementation** — create `app/lib/payments/stripe.server.ts` with `getStripe()` and `createPaymentIntent`. Validate at the boundary (never trust callers); cents in, cents out (no float math).
  ```ts
  import Stripe from "stripe";
  import { getSupabase } from "~/lib/supabase.server";

  let _stripe: Stripe | null = null;

  /** Server-only Stripe SDK singleton. Carries the secret key — never import this module client-side. */
  export function getStripe(): Stripe {
    if (_stripe) return _stripe;
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY is not configured");
    // ponytail: SDK pins its own apiVersion default; pin explicitly when the flow stabilizes.
    _stripe = new Stripe(key);
    return _stripe;
  }

  const KNOWN_CURRENCIES = new Set(["usd", "eur", "gbp", "cad", "aud"]);

  /**
   * Create a Stripe PaymentIntent and persist the shop-scoped payment_intent row.
   * shopId leads because the warehouse has no RLS to infer the tenant on the
   * service-role write path. Returns the client secret for the Payment Element.
   */
  export async function createPaymentIntent(
    shopId: string,
    amountCents: number,
    currency: string,
    orderRef?: string,
  ): Promise<{ paymentIntentId: string; clientSecret: string; amountCents: number; currency: string }> {
    if (!shopId) throw new Error("shopId is required");
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw new Error(`amountCents must be a positive integer, got ${amountCents}`);
    }
    const cur = currency.toLowerCase();
    if (!KNOWN_CURRENCIES.has(cur)) {
      throw new Error(`unsupported currency: ${currency}`);
    }

    const pi = await getStripe().paymentIntents.create({
      amount: amountCents,
      currency: cur,
      automatic_payment_methods: { enabled: true },
      metadata: { shop_id: shopId, order_ref: orderRef ?? "" },
    });
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
    });
    if (error) throw error;

    return {
      paymentIntentId: pi.id,
      clientSecret: pi.client_secret,
      amountCents,
      currency: cur,
    };
  }
  ```
- [ ] **Step 4: Run test to verify it passes** (Run: `npx vitest run app/lib/payments/stripe.server.test.ts`) Expected: PASS — both `createPaymentIntent` tests green.
- [ ] **Step 5: Commit**
  ```bash
  git add app/lib/payments/stripe.server.ts app/lib/payments/stripe.server.test.ts && git commit -m "lib/payments: createPaymentIntent (PI create + shop-scoped persist + boundary validation)"
  ```

---

### Task 4: `processStripeEvent` — signature verify + atomic idempotent record + ledger + status

**Files:**
- Modify: `app/lib/payments/stripe.server.ts`
- Test: `app/lib/payments/stripe.server.test.ts`

- [ ] **Step 1: Write the failing test** — append a `processStripeEvent` block to `app/lib/payments/stripe.server.test.ts`. The idempotency test uses a faithful in-memory stand-in for `record_stripe_event` (enforces `unique(stripe_event_id)` + one ledger row per first delivery) so it checks behavior, not a stub. Add the import `processStripeEvent` to the existing import line.
  ```ts
  // Add to the existing import: import { createPaymentIntent, processStripeEvent } from "./stripe.server";

  describe("processStripeEvent", () => {
    const succeededEvent = {
      id: "evt_1",
      type: "payment_intent.succeeded",
      created: 1_700_000_000,
      data: {
        object: {
          id: "pi_1",
          amount_received: 2500,
          currency: "usd",
          latest_charge: "ch_1",
          metadata: { shop_id: "shop-1", order_ref: "order-1" },
        },
      },
    };

    it("records a payment_intent.succeeded event exactly once across duplicate deliveries", async () => {
      h.constructEvent.mockReturnValue(succeededEvent);

      // Faithful stand-in for the record_stripe_event SQL function: unique(stripe_event_id)
      // + exactly one ledger row per first delivery. The real guarantee is the DB unique
      // constraint, exercised end-to-end in the Verification task via `stripe trigger`.
      const ledger: Array<Record<string, unknown>> = [];
      const seen = new Set<string>();
      h.rpc.mockImplementation(async (_fn: string, a: Record<string, any>) => {
        if (seen.has(a.p_event_id)) return { data: false, error: null };
        seen.add(a.p_event_id);
        if (a.p_kind) {
          ledger.push({ stripe_event_id: a.p_event_id, kind: a.p_kind, amount_cents: a.p_amount_cents });
        }
        return { data: true, error: null };
      });

      const first = await processStripeEvent("raw-body", "sig");
      const second = await processStripeEvent("raw-body", "sig"); // Stripe redelivers the same evt_

      expect(first).toEqual({ status: 200, processed: true, duplicate: false });
      expect(second).toEqual({ status: 200, processed: false, duplicate: true });
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({ kind: "capture", amount_cents: 2500 });
      expect(h.rpc).toHaveBeenCalledTimes(2);
      // stripe_ref takes the charge id from the PI's latest_charge.
      expect(h.rpc.mock.calls[0][1]).toMatchObject({
        p_event_id: "evt_1",
        p_shop_id: "shop-1",
        p_stripe_pi_id: "pi_1",
        p_new_status: "succeeded",
        p_kind: "capture",
        p_amount_cents: 2500,
        p_stripe_ref: "ch_1",
        p_signature_verified: true,
      });
    });

    it("rejects an invalid signature with 400 and writes nothing", async () => {
      h.constructEvent.mockImplementation(() => {
        throw new Error("Webhook signature verification failed");
      });
      const res = await processStripeEvent("raw-body", "bad-sig");
      expect(res).toEqual({ status: 400, processed: false, duplicate: false });
      expect(h.rpc).not.toHaveBeenCalled();
    });

    it("rejects a missing signature with 400 and writes nothing", async () => {
      const res = await processStripeEvent("raw-body", null);
      expect(res).toEqual({ status: 400, processed: false, duplicate: false });
      expect(h.constructEvent).not.toHaveBeenCalled();
      expect(h.rpc).not.toHaveBeenCalled();
    });

    it("on payment_intent.payment_failed updates status but writes no ledger row", async () => {
      h.constructEvent.mockReturnValue({
        ...succeededEvent,
        id: "evt_2",
        type: "payment_intent.payment_failed",
      });
      const ledger: Array<Record<string, unknown>> = [];
      h.rpc.mockImplementation(async (_fn: string, a: Record<string, any>) => {
        if (a.p_kind) ledger.push({ kind: a.p_kind });
        return { data: true, error: null };
      });

      const res = await processStripeEvent("raw-body", "sig");
      expect(res).toEqual({ status: 200, processed: true, duplicate: false });
      expect(h.rpc.mock.calls[0][1]).toMatchObject({ p_new_status: "failed", p_kind: null });
      expect(ledger).toHaveLength(0); // no money moved -> no ledger row (keeps reconciliation exact)
    });

    it("acknowledges an unhandled event type with 200 and writes nothing", async () => {
      h.constructEvent.mockReturnValue({ id: "evt_3", type: "charge.updated", created: 1, data: { object: {} } });
      const res = await processStripeEvent("raw-body", "sig");
      expect(res).toEqual({ status: 200, processed: false, duplicate: false });
      expect(h.rpc).not.toHaveBeenCalled();
    });
  });
  ```
- [ ] **Step 2: Run test to verify it fails** (Run: `npx vitest run app/lib/payments/stripe.server.test.ts`) Expected: FAIL — `processStripeEvent is not a function` / not exported.
- [ ] **Step 3: Write minimal implementation** — append `processStripeEvent` to `app/lib/payments/stripe.server.ts`. Verify the signature over the raw body first; only `payment_intent.succeeded`/`payment_intent.payment_failed` reach the DB; delegate the atomic record-or-skip to the `record_stripe_event` rpc; log-only stub for the paid step.
  ```ts
  /**
   * Verify + idempotently process a Stripe webhook event over the RAW request body.
   * Returns the HTTP status the route should send plus whether this was a first
   * delivery (processed) or a duplicate (no-op). Writes nothing on bad/missing signature.
   */
  export async function processStripeEvent(
    rawBody: string,
    signature: string | null,
  ): Promise<{ status: number; processed: boolean; duplicate: boolean }> {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not configured");
    if (!signature) {
      return { status: 400, processed: false, duplicate: false };
    }

    // Signature verification via the SDK over raw bytes — never hand-rolled.
    let event: Stripe.Event;
    try {
      event = getStripe().webhooks.constructEvent(rawBody, signature, secret);
    } catch {
      return { status: 400, processed: false, duplicate: false };
    }

    // Only money-moving / status events touch the DB; ack everything else so Stripe stops retrying.
    if (event.type !== "payment_intent.succeeded" && event.type !== "payment_intent.payment_failed") {
      return { status: 200, processed: false, duplicate: false };
    }

    const pi = event.data.object as Stripe.PaymentIntent;
    const shopId = pi.metadata?.shop_id;
    if (!shopId) {
      // Fail visibly (rule 12): an event we can't tie to a tenant must not be silently dropped.
      throw new Error(`Stripe event ${event.id} has no shop_id in PaymentIntent metadata`);
    }

    const succeeded = event.type === "payment_intent.succeeded";
    const stripeRef =
      typeof pi.latest_charge === "string" && pi.latest_charge ? pi.latest_charge : pi.id;

    const { data, error } = await getSupabase().rpc("record_stripe_event", {
      p_event_id: event.id,
      p_type: event.type,
      p_shop_id: shopId,
      p_signature_verified: true,
      p_payload: event as unknown as Record<string, unknown>,
      p_stripe_pi_id: pi.id,
      p_new_status: succeeded ? "succeeded" : "failed",
      p_kind: succeeded ? "capture" : null,
      p_amount_cents: succeeded ? pi.amount_received : null,
      p_currency: pi.currency,
      p_stripe_ref: stripeRef,
      p_occurred_at: new Date(event.created * 1000).toISOString(),
    });
    if (error) throw error;

    const processed = data === true; // true = first delivery, false = duplicate no-op
    if (processed && succeeded) {
      // ponytail: STUBBED order step — no order table until #2. Upgrade: real order.state='paid' via #2's adapter.
      console.info(`[stripe] would set order ${pi.metadata?.order_ref || "(none)"} to paid for PI ${pi.id}`);
    }
    return { status: 200, processed, duplicate: !processed };
  }
  ```
- [ ] **Step 4: Run test to verify it passes** (Run: `npx vitest run app/lib/payments/stripe.server.test.ts`) Expected: PASS — idempotency (one ledger row across two deliveries), signature rejection (400, nothing written), missing signature (400), failed-event-no-ledger, and unhandled-type-ack all green.
- [ ] **Step 5: Commit**
  ```bash
  git add app/lib/payments/stripe.server.ts app/lib/payments/stripe.server.test.ts && git commit -m "lib/payments: processStripeEvent (signature verify + atomic idempotent ledger + status)"
  ```

---

### Task 5: Public webhook route `webhooks.stripe.tsx`

**Files:**
- Create: `app/routes/webhooks.stripe.tsx`
- Test: `app/routes/__tests__/webhooks.stripe.test.ts`

- [ ] **Step 1: Write the failing test** — create `app/routes/__tests__/webhooks.stripe.test.ts`. Assert the action reads the raw body + `stripe-signature` header, returns 200 on success, 200 on duplicate, 400 on bad signature, and 405 on non-POST. Mock `processStripeEvent`.
  ```ts
  import { describe, it, expect, beforeEach, vi } from "vitest";

  const { processStripeEvent } = vi.hoisted(() => ({ processStripeEvent: vi.fn() }));
  vi.mock("~/lib/payments/stripe.server", () => ({ processStripeEvent }));

  import { action } from "../webhooks.stripe";

  function post(body: string, sig?: string): Request {
    const headers = new Headers({ "content-type": "application/json" });
    if (sig) headers.set("stripe-signature", sig);
    return new Request("https://app.example.com/webhooks/stripe", { method: "POST", headers, body });
  }

  describe("webhooks.stripe action", () => {
    beforeEach(() => vi.clearAllMocks());

    it("passes the raw body + signature to processStripeEvent and returns its status (success)", async () => {
      processStripeEvent.mockResolvedValue({ status: 200, processed: true, duplicate: false });
      const res = await action({ request: post('{"id":"evt_1"}', "t=1,v1=abc") } as never);
      expect(res.status).toBe(200);
      expect(processStripeEvent).toHaveBeenCalledWith('{"id":"evt_1"}', "t=1,v1=abc");
    });

    it("returns 200 on a duplicate delivery", async () => {
      processStripeEvent.mockResolvedValue({ status: 200, processed: false, duplicate: true });
      const res = await action({ request: post('{"id":"evt_1"}', "t=1,v1=abc") } as never);
      expect(res.status).toBe(200);
    });

    it("returns 400 when the signature is invalid", async () => {
      processStripeEvent.mockResolvedValue({ status: 400, processed: false, duplicate: false });
      const res = await action({ request: post('{"id":"evt_1"}', "bad") } as never);
      expect(res.status).toBe(400);
    });

    it("rejects non-POST with 405", async () => {
      const req = new Request("https://app.example.com/webhooks/stripe", { method: "GET" });
      const res = await action({ request: req } as never);
      expect(res.status).toBe(405);
      expect(processStripeEvent).not.toHaveBeenCalled();
    });
  });
  ```
- [ ] **Step 2: Run test to verify it fails** (Run: `npx vitest run app/routes/__tests__/webhooks.stripe.test.ts`) Expected: FAIL — `Cannot find module '../webhooks.stripe'`.
- [ ] **Step 3: Write minimal implementation** — create `app/routes/webhooks.stripe.tsx` as a resource route (action only, no default export → no client component, server-only). Do NOT call `authenticate.admin` — this is a public, Stripe-signed endpoint.
  ```tsx
  import type { ActionFunctionArgs } from "@remix-run/node";
  import { processStripeEvent } from "~/lib/payments/stripe.server";

  // Public, unauthenticated Stripe webhook. Stripe signs the request; the signature
  // is verified against the RAW body inside processStripeEvent before any DB write.
  export async function action({ request }: ActionFunctionArgs) {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    const signature = request.headers.get("stripe-signature");
    const rawBody = await request.text(); // raw bytes required for signature verification
    const result = await processStripeEvent(rawBody, signature);
    const body =
      result.status === 200 ? (result.duplicate ? "duplicate" : "ok") : "invalid signature";
    return new Response(body, { status: result.status });
  }
  ```
- [ ] **Step 4: Run test to verify it passes** (Run: `npx vitest run app/routes/__tests__/webhooks.stripe.test.ts`) Expected: PASS — success/duplicate/bad-signature/non-POST all return the right status; raw body + signature forwarded.
- [ ] **Step 5: Commit**
  ```bash
  git add app/routes/webhooks.stripe.tsx app/routes/__tests__/webhooks.stripe.test.ts && git commit -m "routes/webhooks.stripe: public Stripe webhook (raw body + signature boundary, 200 on duplicate)"
  ```

---

### Task 6: Test-mode Payment Element checkout route `app.checkout-test.tsx`

**Files:**
- Create: `app/routes/app.checkout-test.tsx`

- [ ] **Step 1: Write the failing test** — this route is a Polaris/App-Bridge + Stripe-Element UI harness verified manually (a meaningful unit test would only assert against the mocked SDK, not real behavior — rule 9). The "failing test" is a typecheck/build that fails because the route does not exist yet:
  ```bash
  test -f app/routes/app.checkout-test.tsx && echo "EXISTS" || echo "MISSING"
  ```
- [ ] **Step 2: Run test to verify it fails** (Run: the command above) Expected: FAIL — prints `MISSING`.
- [ ] **Step 3: Write minimal implementation** — create `app/routes/app.checkout-test.tsx`. Loader is read-only (exposes only the publishable key, per repo convention); the PI-creating mutation lives in the action. The component mounts the Stripe Payment Element with the publishable key only.
  ```tsx
  import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
  import { useFetcher, useLoaderData } from "@remix-run/react";
  import { useState } from "react";
  import { loadStripe } from "@stripe/stripe-js";
  import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
  import { Page, Card, Button, Banner, BlockStack } from "@shopify/polaris";
  import { authenticate } from "~/shopify.server";
  import { resolveShopId } from "~/lib/supabase.server";
  import { createPaymentIntent } from "~/lib/payments/stripe.server";

  // Loaders are read-only (repo convention): expose only the client-safe publishable key.
  export async function loader({ request }: LoaderFunctionArgs) {
    await authenticate.admin(request);
    const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY;
    if (!publishableKey) throw new Error("STRIPE_PUBLISHABLE_KEY is not configured");
    return json({ publishableKey });
  }

  // Mutation: create the PaymentIntent (persists a payment_intent row) and return its client secret.
  export async function action({ request }: ActionFunctionArgs) {
    const { session } = await authenticate.admin(request);
    // ponytail: spike harness borrows the embedded-admin shop for shop_id. Upgrade:
    // the real buyer checkout is the unauthenticated storefront (#7), shop from host/subdomain.
    const shopId = await resolveShopId(session.shop);
    // ponytail: single hardcoded test amount ($25.00). Upgrade: amount from the cart/order (#2).
    const { clientSecret } = await createPaymentIntent(shopId, 2500, "usd");
    return json({ clientSecret });
  }

  function CheckoutForm() {
    const stripe = useStripe();
    const elements = useElements();
    const [error, setError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);

    async function onPay() {
      if (!stripe || !elements) return;
      setSubmitting(true);
      setError(null);
      // redirect: "if_required" keeps test-card (4242...) flow on-page; no return_url / window.* needed.
      const { error: payError } = await stripe.confirmPayment({ elements, redirect: "if_required" });
      if (payError) setError(payError.message ?? "Payment failed");
      setSubmitting(false);
    }

    return (
      <BlockStack gap="400">
        <PaymentElement />
        {error ? <Banner tone="critical">{error}</Banner> : null}
        <Button variant="primary" loading={submitting} onClick={onPay}>
          Pay $25.00 (test)
        </Button>
      </BlockStack>
    );
  }

  export default function CheckoutTest() {
    const { publishableKey } = useLoaderData<typeof loader>();
    const fetcher = useFetcher<typeof action>();
    const [stripePromise] = useState(() => loadStripe(publishableKey));
    const clientSecret = fetcher.data?.clientSecret;

    return (
      <Page title="Test checkout (Stripe)">
        <Card>
          {!clientSecret ? (
            <fetcher.Form method="post">
              <Button submit variant="primary" loading={fetcher.state !== "idle"}>
                Start test payment
              </Button>
            </fetcher.Form>
          ) : (
            <Elements stripe={stripePromise} options={{ clientSecret }}>
              <CheckoutForm />
            </Elements>
          )}
        </Card>
      </Page>
    );
  }
  ```
- [ ] **Step 4: Run test to verify it passes**
  ```bash
  test -f app/routes/app.checkout-test.tsx && npm run typecheck && npm run build
  ```
  Expected: PASS — route exists, `tsc --noEmit` exits 0, and `npm run build` completes including `verify:client-bundle` (no source maps / forbidden markers; the `stripe` server SDK is not in the client bundle because it is imported only from `*.server.ts`).
- [ ] **Step 5: Commit**
  ```bash
  git add app/routes/app.checkout-test.tsx && git commit -m "routes/app.checkout-test: test-mode Stripe Payment Element checkout harness"
  ```

---

### Task 7 (Verification): live round-trip + green gate

**Files:**
- None (verification only)

- [ ] **Step 1: Start the dev server + Stripe listener.** In one shell: `npm run dev`. In another: `stripe login`, then `stripe listen --forward-to localhost:<port>/webhooks/stripe` (use the port the Remix dev server prints). Copy the printed `whsec_…` into `STRIPE_WEBHOOK_SECRET` in `.env.local` and restart `npm run dev` so the new secret is loaded.
- [ ] **Step 2: Trigger a capture and assert exactly ONE ledger row.** Run `stripe trigger payment_intent.succeeded`. Then query the DB (Supabase MCP `execute_sql` or `supabase db query`):
  ```sql
  select count(*) from public.transaction_ledger where stripe_event_id = '<evt_id_from_stripe_listen>';
  ```
  Expected: `1`. Re-deliver the **same** event (resend from the Stripe dashboard, or re-run the captured payload) and re-query — still `1` (the second delivery is a no-op; `webhooks.stripe` returns 200). Also confirm `select status from public.payment_intent where stripe_pi_id = '<pi_id>'` is `succeeded`, and the dev log shows `"[stripe] would set order … to paid"`.
- [ ] **Step 3: Manual Payment Element round-trip.** Open `/app/checkout-test` in the embedded admin, click "Start test payment", pay with `4242 4242 4242 4242` (any future expiry / any CVC). Expect: PI succeeds → `payment_intent.succeeded` arrives → exactly one new `capture` ledger row (positive `amount_cents`) → `payment_intent.status='succeeded'`.
- [ ] **Step 4: Reconciliation check.**
  ```sql
  select sum(amount_cents) from public.transaction_ledger
   where payment_intent_id = (select id from public.payment_intent where stripe_pi_id = '<pi_id>');
  ```
  Expected: equals the PI's captured amount in Stripe exactly (no float drift; signed correctly).
- [ ] **Step 5: Green pre-commit gate (run, paste evidence — do not assert success without output).**
  ```bash
  npm run test && npm run typecheck && npm run lint && npm run build
  ```
  Expected: all exit 0 — the idempotency / signature-rejection unit tests are green, `tsc --noEmit` clean, ESLint clean on touched files, Remix+Vite build completes with `verify:client-bundle` green (only `pk_test_…` ever client-side; no secret key, no source maps). `npx prisma validate` is not required (no Prisma schema change — these are warehouse tables).

---

## Spec coverage map

| Spec requirement (`2026-06-28-stripe-spike-design.md`) | Task |
|---|---|
| 3 warehouse tables (`payment_intent`, `transaction_ledger`, `stripe_event`), RLS mirrors `refund_fact`, `supabase/migrations/` only | Task 2 |
| Atomic record-or-skip (one SQL function = one transaction; on-conflict do nothing; ledger + status in same tx) | Task 2 (`record_stripe_event`) + Task 4 (`processStripeEvent` calls it) |
| `createPaymentIntent(shopId, amountCents, currency, orderRef?)` — PI create, tenant metadata, persist row, return client secret, boundary validation, no float | Task 3 |
| Webhook: signature verify → idempotent insert → ledger + status → stubbed paid log | Task 4 |
| Events `payment_intent.succeeded` (capture) + `payment_intent.payment_failed` (no ledger); other types acked 200 | Task 4 |
| Public webhook route (raw body, 200 on duplicate, 400 bad signature) | Task 5 |
| Test-mode Payment Element checkout (publishable key only, admin-gated harness) | Task 6 |
| New deps flagged + 3 TEST-mode env keys in `.env.local`/`.env.example` | Task 1 |
| Tests: idempotency (one row), signature rejection, reconciliation | Task 4 (unit) + Task 7 (live reconciliation) |
| Manual Stripe CLI round-trip + exactly one ledger row + replays no-op | Task 7 |
| Pre-commit gate (typecheck/lint/build green, verify-client-bundle, no Prisma change) | Task 7 |
| PCI SAQ-A, signature-via-SDK, secrets server-side, integer cents, append-only, fail-visibly | SECURITY section + enforced in Tasks 2–6 |
| Dashboard parity | N/A this round — spec **Out of scope** ("no merchant-facing dashboard UI yet"; `TODO(parity)` recorded for when #3 graduates to a real feature). No dashboard task. |
