# Orders Create & Edit + Recovery (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merchant-created invoice orders, paid-order line reductions with automatic refund+restock, and abandoned-checkout recovery emails — per the spec's Phase 3 section (adversarially verified; the reaper exemption and pay-link session-refresh are launch-blocking requirements, not niceties).

**Architecture:** Invoices reuse the owned order spine (cart → order channel 'invoice' → hosted Stripe session minted lazily per pay-link click → normal paid webhook). Edits are append-only `order_line_edit` audit rows; `order_line` snapshots are never mutated; three read sites net out reductions. Recovery rebuilds a fresh cart from order snapshots via existing cart primitives.

**Tech Stack:** Same as Phases 1-2. Branch `feat/orders-create-edit` off main, one PR.

## Global Constraints

- All Phase 1/2 Global Constraints apply (RLS pattern, same-origin writes, cd-* primitives, CDIcon icons, no em dashes, integer cents, unique migration prefixes `202607xx...`). `checkout.server.ts` / `stripe.server.ts` / `connect.server.ts` are NO LONGER frozen (the parallel branch merged) — but read them fresh before editing; they changed recently (#398/#400/#401).
- Verifier facts that BIND this plan:
  - The reaper (`app/lib/order/abandon-reaper.server.ts`, `REAP_AFTER_MS = 24h`, cron `20 * * * *`) cancels ALL stale `checkout_pending` orders and its paid-race check only sees existing `payment_intent` rows; hosted sessions create no PI row until completion. Invoice orders MUST be exempted inside the reaper query.
  - Hosted Checkout sessions expire ≤24h; never email a raw `session.url`.
  - `executeRefundAction`'s restock flag fires only on FULL refunds — the edit flow calls `inventory_restock` directly.
  - `restockOrderLines` is whole-order; do not use it for per-line restock.
  - `listAbandonedCheckouts` has no channel filter; `listDraftCarts` matches any `cart`-state cart with lines. Both need exclusions.
  - `cart.buyer_id` is nullable; `buildCart()`/`addCartLine()` exist and re-snapshot live prices; storefront cart identity = signed httpOnly `cd_cart` cookie (`storefront/cart-cookie.server.ts`).
  - `buyer_consent` rows: `policy in ('tos','privacy','marketing')`, `accepted boolean`; storefront checkout always records them.
  - `orders.channel` is unconstrained text (default 'storefront').

---

### Task 1: migration + inventory fallback + reaper/list exclusions

**Files:**
- Create: `supabase/migrations/20260710150000_orders_phase3_spine.sql`
- Modify: `app/lib/inventory/engine.server.ts` (new `saleFallbackForOrder`), `app/lib/payments/stripe.server.ts` (wire fallback after commit), `app/lib/order/abandon-reaper.server.ts` (invoice exemption), `app/lib/order/list.server.ts` (two exclusions)
- Tests: reaper test extension, engine fallback test, stripe webhook test extension, list exclusions tests

**Migration contents:**
```sql
-- Phase 3 spine: merchant drafts, invoice recovery stamps, line-edit audit, sale fallback.
alter table public.cart add column if not exists origin text;
alter table public.orders add column if not exists recovery_email_sent_at timestamptz;

create table if not exists public.order_line_edit (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  order_id uuid not null,
  order_line_id uuid not null,
  old_quantity int not null check (old_quantity > 0),
  new_quantity int not null check (new_quantity >= 0),
  refund_cents int not null default 0 check (refund_cents >= 0),
  reason text,
  created_at timestamptz not null default now(),
  foreign key (shop_id, order_id) references public.orders (shop_id, id) on delete cascade,
  foreign key (shop_id, order_line_id) references public.order_line (shop_id, id) on delete cascade,
  check (new_quantity < old_quantity)
);
create index if not exists order_line_edit_order_idx on public.order_line_edit (shop_id, order_id);
alter table public.order_line_edit enable row level security;
create policy order_line_edit_shop_scope on public.order_line_edit
  for all using (shop_id = public.current_shop_id()) with check (shop_id = public.current_shop_id());
revoke all on table public.order_line_edit from anon, authenticated;

-- Paid-invoice stock decrement when no reservation was ever held. Relative,
-- FOR UPDATE-locked, idempotent on the caller's key. on_hand MAY go negative:
-- backorder-truth (mirrors inventory_reserve's backorder branch) beats hidden
-- oversell, and the inventory screen surfaces the negative number.
create or replace function public.inventory_sale_fallback(
  p_shop_id uuid, p_variant_id uuid, p_location_id uuid, p_qty int, p_idempotency_key text
) returns void language plpgsql set search_path = '' as $$
begin
  if p_qty < 1 then raise exception 'invalid_qty' using errcode = 'P0001'; end if;
  insert into public.inventory_balance (shop_id, variant_id, location_id, on_hand, version, updated_at)
    values (p_shop_id, p_variant_id, p_location_id, 0, 0, now())
    on conflict (variant_id, location_id) do nothing;
  perform 1 from public.inventory_balance
    where shop_id = p_shop_id and variant_id = p_variant_id and location_id = p_location_id
    for update;
  if exists (select 1 from public.inventory_ledger
             where shop_id = p_shop_id and idempotency_key = p_idempotency_key) then
    return;
  end if;
  update public.inventory_balance set on_hand = on_hand - p_qty, version = version + 1, updated_at = now()
    where shop_id = p_shop_id and variant_id = p_variant_id and location_id = p_location_id;
  insert into public.inventory_ledger (shop_id, variant_id, location_id, entry_type, qty, idempotency_key, reason, source)
    values (p_shop_id, p_variant_id, p_location_id, 'sale', -p_qty, p_idempotency_key, 'paid_without_hold', 'system');
end $$;
revoke all on function public.inventory_sale_fallback(uuid, uuid, uuid, int, text) from public, anon, authenticated;
```
(Verify `inventory_ledger.entry_type` check already contains 'sale' — it does per the base table — and that `source` accepts 'system'; if source has a check constraint, read it and use an allowed value.)

**Code changes (contracts):**
- `saleFallbackForOrder(shopId, orderId): Promise<{ decremented: number }>` in engine.server.ts: read order_line + tracked variants (reuse the tracked-set read pattern), `ensurePrimaryLocation`, call the RPC per variant with key `salefb:${orderId}:${variantId}`, `projectLevelFact` after each. Skip untracked.
- `stripe.server.ts` `payment_intent.succeeded` path: after `commitReservation(shopId, orderRef)`, detect the nothing-held case (read how commit reports it — if it's a silent no-op, query `inventory_reservation` for the checkout_ref: zero rows for the order → call `saleFallbackForOrder`). Idempotent across redeliveries by the RPC's key. Never throw past it (log loudly on failure; the payment already happened).
- Reaper: exclude `channel = 'invoice'` in the stale-orders query, with a comment naming the stranded-money failure mode. Extend its test: an old invoice order is NOT reaped.
- `listAbandonedCheckouts`: `.neq("channel", "invoice")` (also add the `.neq("channel", "test")` the sibling query has, noting it). `listDraftCarts`: exclude `origin = 'merchant_draft'` (`.or("origin.is.null,origin.neq.merchant_draft")` — or `.neq` with null-safe check; verify PostgREST null semantics: `.neq` drops NULL rows! Use the `.or` form and test it).
- Controller applies the migration to prod.

### Task 2: invoice backend (draft CRUD + send + pay-link + void)

**Files:**
- Create: `app/lib/order/invoice.server.ts` (`sendDraftOrderInvoice`, `payableInvoiceSession`), `app/routes/dashboard.api.orders.drafts.tsx` (merchant-draft CRUD: GET list / POST create-or-update lines / DELETE), `app/routes/dashboard.api.orders.drafts.send.tsx` (POST: validated buyer email/address/note + cartId → sendDraftOrderInvoice), `app/routes/storefront.invoice.$token.pay.tsx` (public pay-link redirect), invoice email sender added to `app/lib/order/notify-email.server.ts`
- Modify: `app/lib/dashboard/orders-client.ts` (draft + send wrappers)
- Tests: invoice.server tests (send happy path: order channel invoice + lines snapshotted + cart consumed + email fired; no reservation calls), pay-link route tests (fresh session created; stale session expired+recreated — mock the stripe seam; order already paid → redirect to confirmation; cancelled/voided → 410-style page), drafts routes tests

**Contracts:**
- `sendDraftOrderInvoice(shopId, cartId, buyer: {email, address?, note?})`: mirrors `createCheckout`'s pricing/order-insert shape (read it fresh) but channel 'invoice', NO reserveStock block, NO PaymentIntent creation (payment is minted by the pay-link route). Returns `{orderId, confirmationToken, totalCents, currency}`. Sends the invoice email (subject "Invoice for order {ref}", body: line summary, total, pay link `${publicBaseUrl()}/storefront/invoice/${token}/pay`, note when present; escapeHtml on merchant note; no em dashes).
- `payableInvoiceSession(shopId, token)`: resolve order by confirmation token; must be `channel='invoice'` and state `checkout_pending` (paid → return `{kind:'paid', confirmationUrl}`; cancelled → `{kind:'void'}`); create a fresh hosted session via the existing `createCommerceCheckoutSession` seam (read its exact signature incl. the readiness param from #398), storing/expiring any prior session id (add `orders.invoice_session_id text` if needed — prefer stateless: always create a new session; Stripe tolerates parallel sessions and completion webhooks reconcile by PI, verify how checkout.session.completed maps to the order via metadata order_ref).
- Pay-link route: public (no dashboard session — the token IS the auth, same trust model as the confirmation page); loader → `payableInvoiceSession` → 302 to session.url / confirmation page / a minimal "This invoice is no longer payable." page. Rate limiting not required v1 (token is 256-bit).
- Void invoice: reuse the existing cancel executor via the existing cancel route (no refund; reason `invoice_void`) — UI-only concern in Task 5; note it needs `checkout_pending` cancel which already releases nothing (no holds) and works.

### Task 3: order editing backend (paid reductions + unpaid invoice edits)

**Files:**
- Create: `app/lib/order/edit.server.ts` (`executeReduceLineAction`), `app/routes/dashboard.api.orders.$id.reduce-line.tsx`
- Modify: `app/lib/inventory/engine.server.ts` (`restockLine(shopId, orderId, variantId, qty, key)` thin wrapper over inventory_restock), `app/lib/order/emit.server.ts` + `app/lib/order/fulfill.server.ts` + `app/lib/order/detail.server.ts` (effective-quantity netting: shared helper `effectiveLineQuantities(shopId, orderId)` in a new `app/lib/order/line-edits.server.ts` returning Map<lineId, {snapshot, reduced, effective}>), invoice-edit route `app/routes/dashboard.api.orders.$id.edit-lines.tsx` (unpaid invoice orders only: replace lines wholesale, re-price, update totals)
- Tests: edit executor matrix (precondition failures: not native / not paid states / below-fulfilled / no-op qty; happy: audit row + refund delta exact + per-line restock called + timeline), netting tests per read site (a reduced line: detail shows effective, fulfill remaining respects it, emit redelivery re-read nets it), invoice-edit route tests

**executeReduceLineAction contract:** input `{orderId, orderLineId, newQuantity, restock: boolean, reason?, idempotencyKey}`. Steps: replay check → load order (native, state ∈ paid/partially_fulfilled/fulfilled) + line + prior edits + fulfilled qty for the line → preconditions (`newQuantity < currentEffective`, `newQuantity >= fulfilledQty`) → insert `order_line_edit` row → refund delta = `(currentEffective − newQuantity) × unit_price_cents` via `executeRefundAction(shopId, {orderId, amountCents: delta, idempotencyKey: key+":refund", reason: "line reduction", actor})` (restock: false — restock handled here) → when `restock`: `restockLine(..., key: \`editrestock:${orderId}:${orderLineId}:${auditableCount}\`)` — derive a stable counter from the edit row id → audit row `action_kind: 'issue_refund'`? NO — the refund executor writes its own audit; the edit itself records via the order_line_edit row + timeline; skip a second action_audit (note this decision in the module header).
- Detail timeline gains an `edit` event kind sourced from order_line_edit rows.

### Task 4: recovery backend

**Files:**
- Create: `app/routes/storefront.recover.$token.tsx` (resume link), `app/lib/order/recovery.server.ts` (`sendRecoveryEmail(shopId, orderId, {force})`, `autoSendRecoveryEmails(shopId?)`), `app/routes/dashboard.api.orders.$id.recovery-email.tsx` (manual POST), cron wiring (extend the existing abandon-reaper cron route to ALSO run auto-recovery BEFORE reaping, or a separate function invoked in the same cron — read `app/routes/cron.order-reaper.tsx` and follow its auth/shape; do not add a new vercel.json cron entry unless unavoidable)
- Modify: `app/lib/order/notify-email.server.ts` (recovery sender), `app/lib/order/list-types.ts`/`list.server.ts` (abandoned rows gain `recoveryEmailSentAt`), `app/lib/dashboard/orders-client.ts`
- Tests: recovery.server tests (consent gate: no marketing consent → skipped + recorded reason; sent stamps recovery_email_sent_at; at-most-once; channel guard storefront-only; 4h window before 24h reap), resume route tests (fresh cart built from snapshots via cart primitives + cd_cart cookie committed + redirect to checkout; cancelled original still works; unknown token 404)

**Contracts:**
- `sendRecoveryEmail`: order must be `channel='storefront'`, state `checkout_pending` OR (cancelled by the reaper with reason its cancel reason — read what reason string the reaper writes and accept both), `recovery_email_sent_at is null` (unless force=true for the manual button — manual re-send allowed once more, cap 2 total: track via timestamp + a count? Keep v1: manual send allowed even when already sent; auto-send strictly at-most-once via the stamp). Consent: auto path requires marketing consent accepted; manual path also requires it (merchant can't override consent) — return a structured `{sent:false, reason:'no_consent'}` the UI can surface honestly.
- Email: subject "You left something behind" style copy (plain, no em dashes), line summary, resume link `${publicBaseUrl()}/storefront/recover/${token}`, note that prices reflect current availability.
- Resume route: resolve order by token (any shop — token is globally unguessable but the lookup must still be shop-scoped: find how storefront routes resolve the shop/tenant — read a storefront.* route for the tenant-resolution pattern and follow it; the order lookup gives shop_id — verify the storefront route serves the right tenant domain for that shop or redirects to it).
- `autoSendRecoveryEmails`: orders `channel='storefront'`, state checkout_pending, age between 4h and 24h, no stamp, consent ok → send loop (bounded, e.g. 50/run).
- Attribution: the resume route stamps the NEW cart with `origin: 'recovery:<orderId>'`; `createCheckout` copies cart origin into the order's attribution as `recovered_from` when present (read how attribution flows from the storefront checkout route into createCheckout and thread it the same way — smallest honest change).

### Task 5: UI (composer, invoice actions, edit lines, recovery buttons)

**Files:**
- Create: `app/components/dashboard/screens/OrderComposer.tsx` (Create order flow), `ReduceLineModal.tsx`
- Modify: `Orders.tsx` ("Create order" Btn in the header; Abandoned tab rows gain "Send recovery email" button + sent-at caption), `OrderDetail.tsx` (invoice orders: "Re-send invoice" + "Void invoice" actions + unpaid-invoice "Edit items" affordance; paid orders: per-line "Reduce" affordance opening ReduceLineModal; timeline renders edit events), `orders-client.ts`
- Composer behavior: variant search (reuse whatever product-search client the catalog/product screens use — find the existing search endpoint; do NOT build a new one), line list with qty steppers, customer email + optional address form (reuse the address field pattern from checkout or customer screens), note field; actions: Save draft / Send invoice (confirm shows total incl. quoted shipping+tax when address present); after send → navigate to the new order's detail.
- ReduceLineModal: current qty → new qty stepper (min = fulfilled qty, noted in copy), refund preview (delta amount), restock checkbox default ON, "Refund {money} and update the order?" confirm; on success refetch detail.
- All cd-* primitives; no em dashes; icons via CDIcon.

### Task 6: gate + e2e + final review + PR 5

- Full gate (typecheck, lint, build, full vitest).
- Browser e2e vs prod DB (minted session, Peak & Pine): compose draft → send invoice (email best-effort; verify order lands channel=invoice + NOT in Abandoned tab + pay-link route redirects to a Stripe URL); reduce a paid order's line (refund executes against ledger or fails cleanly on no-PI demo orders — verify the error surfaces; on an order with a real capture if one exists, verify refund+restock+timeline); recovery: manual send on an abandoned row (consent-gated result surfaced), resume link rebuilds a cart and lands on checkout.
- Final whole-branch review (most capable model) → fix wave → re-verify.
- Push, `gh pr create` vs main, ledger + memory.
