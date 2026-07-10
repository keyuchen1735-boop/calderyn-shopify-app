# Orders close-out — design

**Date:** 2026-07-09
**Status:** Approved (Phase 1 detailed; Phases 2-4 summarized, each gets its own design pass)
**Goal:** Finish the dashboard Orders section so it covers everything Shopify's Orders section does, plus a Calderyn-only intelligence layer — then nothing further is needed on Orders.

## Context (current state, verified 2026-07-09)

The Orders screen (`app/components/dashboard/screens/Orders.tsx`, 460 lines) shows a unified list of native orders (`orders`/`order_line` spine) and imported Shopify history (`imported_order`), with four sub-tabs (Orders, Shipping charges, Draft carts, Abandoned) and one action: amount-based refund via `RefundModal` → `app/lib/actions/refund.server.ts`.

What's solid underneath: the order state machine with CAS-guarded transitions and an append-only `order_state_transition` audit trail, an idempotent Stripe refund executor with ledger truth, a complete inventory engine (`inventory_reserve/commit/release` RPCs + reaper cron), order-confirmation email via Resend, and a customer directory.

**Baseline correction (verified against origin/main, 2026-07-09 afternoon):** the core oversell fix has ALREADY shipped to main — `createCheckout` reserves tracked lines and cancels the order on stockout, the `payment_intent.succeeded` webhook commits reservations (plus stranded-order recovery), and `seedInitialStock`/`ensurePrimaryLocation` seed balance rows at product save. A parallel in-flight branch (`feat/checkout-payments-hardening`) is adding payments-readiness gates in the same files; this project must not touch `checkout.server.ts`/`stripe.server.ts`/`connect.server.ts` to avoid colliding with it.

The gaps this project closes:

- **Inventory loose ends** — no restock on refund, the agentic order path (`placeAgenticOrder`) still doesn't reserve, and nothing releases holds on merchant cancel (no cancel exists).
- `fulfilled` and `cancelled` are legal states **no merchant action ever reaches** — no fulfill/cancel action, no tracking numbers, no fulfillment tables.
- **No order detail view** of any kind; the audit trail is never rendered.
- List API takes **zero query params** — no search, filters, sort, or pagination (100-row cap).
- No notes, tags, archiving, exports, packing slips, draft-order creation, order editing, returns, or recovery emails.
- Only one transactional email exists (order confirmation).

## Roadmap (agreed sequencing — spine-first, four phases)

Each phase is its own spec → plan → PR train, shippable on its own.

1. **Order core** (detailed below) — inventory wiring (oversell fix), fulfillment + tracking, cancel, order detail page with timeline/notes/tags/archive, transactional emails.
2. **List power tools** — server-side search, filters (status/date/customer/tag), sortable columns, real pagination, saved views, bulk actions (multi-select fulfill/tag/archive), CSV export, printable packing slips and invoices.
3. **Create & edit** — merchant-created draft orders (line picker, invoice email, Stripe payment collection, convert-to-order), order editing (add/remove/adjust lines with inventory + payment reconciliation), abandoned-checkout recovery emails with resume links and recovered-revenue tracking.
4. **Returns & the Calderyn layer** — returns/exchanges (RMA lifecycle, line-item refunds, restock on return), profit-per-order (COGS from line cost snapshots + matched carrier cost from `shipping_invoice_line` + ad attribution), Autopilot order signals (stuck orders, refund risk, repeat-customer flags in the order view), Ask Calderyn order tools (extend the existing in-app assistant with order query/action tools — no new assistant system).

Explicitly deferred beyond Phase 4 (not forgotten, just not blocking "closed out"): risk/fraud scoring, duties/international pricing, local delivery/pickup and multi-location order routing, manual payment capture / payment terms, notification resend history.

---

# Phase 1 — Order core

## 1. Data model (new SQL migrations; every table shop-scoped with RLS, composite `(shop_id, id)` FKs per order-spine convention)

**`fulfillment`**
- `id uuid pk`, `shop_id`, `order_id` (FK orders), `status text` check in (`shipped`) — single value today, column exists so `delivered` can arrive later without a migration
- `tracking_number text null`, `carrier text null`, `tracking_url text null`
- `created_at`, `notified_at timestamptz null` (at-most-once email stamp)

**`fulfillment_line`**
- `fulfillment_id`, `order_line_id` (FK order_line), `quantity int > 0`
- Sum of a line's fulfillment_line quantities may never exceed `order_line.quantity` (enforced in the action, verified in tests).

**`order_note`**
- `id`, `shop_id`, `order_id`, `author_email text`, `body text`, `created_at`. Append-only staff notes.

**`order_tag`**
- `shop_id`, `order_id`, `tag text`, `unique (shop_id, order_id, tag)`. Tag filtering ships in Phase 2; the editor ships now.

**`orders` alterations**
- `archived_at timestamptz null` — Shopify-style open/archived, orthogonal to state.

## 2. State machine (`app/lib/order/state.ts`)

Add `partially_fulfilled`. New legal transitions:

- `paid → partially_fulfilled → fulfilled`
- `partially_fulfilled → refunded | partially_refunded`
- `paid → cancelled` and `partially_fulfilled → cancelled` (merchant cancel; `fulfilled` orders cannot be cancelled — refund instead)

Everything stays CAS-guarded via `transitionOrder()` with an audit row; badge maps in the UI gain the new state.

**Cancel semantics:** `orders` gains `cancelled_at timestamptz` + `cancel_reason text`, because state alone can't express "cancelled with a refund" (`refunded` is terminal — a refund executed during cancel moves state to `refunded`, and the `cancelled` state is unreachable from there). Rules: cancel on `checkout_pending` releases the reservation and transitions to `cancelled`; cancel on `paid`/`partially_fulfilled` **without** refund transitions to `cancelled` directly; cancel **with** refund runs `executeRefundAction` (state becomes `refunded`) and stamps `cancelled_at`. Every cancel stamps `cancelled_at` + `cancel_reason`, and the UI derives its Cancelled badge from `cancelled_at`/state so both flavors read as cancelled.

## 3. Inventory wiring (remaining pieces — reserve-at-checkout and commit-on-paid already shipped to main)

- **Restock on refund/cancel:** a new atomic `inventory_restock` SQL function (relative on-hand increment + `restock` ledger entry, modeled on `inventory_adjust`) with an optional restock flag on the refund path. Because Phase 1 refunds are amount-based (not line-based), restock is offered only on **full** refunds and on cancel, where "all lines" is unambiguous; per-line restock arrives with line-item refunds in Phase 4. Restock lands at the shop's primary location (`ensurePrimaryLocation`).
- **Release on cancel:** cancelling a `checkout_pending` order releases its reservation immediately (paid orders' holds were already committed, so cancel of a paid order restocks instead).
- **Agentic path:** `placeAgenticOrder` (`app/lib/commerce/order.server.ts`) reserves tracked lines exactly like `createCheckout` (release + fail visibly on stockout); commit flows through the existing webhook path keyed by order id, unchanged.
- Explicitly out: `checkout.server.ts` / `stripe.server.ts` / `connect.server.ts` are owned by the in-flight `feat/checkout-payments-hardening` branch and are not touched.

## 4. API routes (all behind `requireDashboardSession`; writes additionally `requireSameOrigin`, validated bodies, idempotency keys following the refund route's pattern)

- **`GET dashboard.api.orders.$id`** — full detail DTO:
  - order header (ref, state, financial_status, archived_at, source, channel/attribution, created_at)
  - lines with title snapshot, unit price, quantity, **fulfilled quantity**
  - payment breakdown: subtotal / shipping / tax / total / refunded-to-date (from `transaction_ledger`) / net
  - buyer (name, email, link id for the customer screen) + shipping address
  - fulfillments with tracking
  - merged timeline, newest first: `order_state_transition` rows + refund entries from `action_audit` + `order_note` rows + email-sent events
  - tags
  - Imported Shopify orders resolve through the same route to a **read-only** DTO built from `imported_order`/`imported_order_line`/`imported_refund`. Detail ids are source-prefixed (`calderyn:<uuid>` / `shopify:<uuid>`) so one route serves both populations unambiguously.
- **`POST dashboard.api.orders.$id.fulfill`** — body: `lines?: {order_line_id, quantity}[]` (omitted = everything unfulfilled), `tracking_number?`, `carrier?`, `notify: boolean`, `idempotency_key`. Creates `fulfillment` + lines, transitions to `partially_fulfilled`/`fulfilled` by coverage, sends shipping-confirmation email when `notify`.
- **`POST dashboard.api.orders.$id.cancel`** — body: `reason?`, `refund: boolean`, `restock: boolean`, `idempotency_key`. Semantics per §2.
- **`POST dashboard.api.orders.$id.notes`** — `{body}` append.
- **`POST dashboard.api.orders.$id.tags`** — `{tags: string[]}` full replace (simplest correct contract for a small set).
- **`POST dashboard.api.orders.$id.archive`** — `{archived: boolean}` toggle.
- **Refund route** unchanged in shape; gains optional `restock: boolean`.

All routes surface upstream Supabase/Stripe error payloads (never swallowed). Fulfill/cancel replay-dedupe on `idempotency_key` via `action_audit`, like refund.

## 5. Transactional emails (Resend, mirroring `confirmation-email.server.ts`: at-most-once, best-effort, never throws into the calling transaction)

- **Shipping confirmation** — on fulfill with `notify`: items shipped, tracking number + link. Stamped via `fulfillment.notified_at`.
- **Refund notice** — amount refunded, order ref.
- **Cancellation notice** — order cancelled, refund status if any.

Each send lands a timeline event.

## 6. UI

**Order detail screen** — list rows become clickable and navigate to `screen: "orders", param: <source-namespaced id>` (the same NavState `param` pattern campaign detail uses; back returns to the list).

- **Header:** order ref, created date, source; two badges — **Payment** (paid / partially refunded / refunded / pending) and **Fulfillment** (unfulfilled / partially fulfilled / fulfilled), replacing the single conflated badge; action bar: Fulfill, Refund, Cancel, Archive.
- **Main column:** line items card (per-line fulfillment state), payment breakdown card, fulfillments card (tracking, copyable), timeline card with add-note composer.
- **Side column:** customer card (deep-links to the existing customer detail), shipping address, tags editor, channel/attribution.
- **Fulfill modal:** line picker with quantities (defaults to all unfulfilled), tracking number + carrier fields, "notify customer" checkbox.
- **Cancel modal:** reason, refund toggle (full), restock toggle.
- **Imported orders** render the same page read-only with "managed at Shopify" hints where actions would be.
- Composed entirely from existing `cd-*` primitives; Lucide icons via `CDIcon` only.

**List changes (deliberately minimal — power tools are Phase 2):** clickable rows, split Payment/Fulfillment badges, item count column. The list API response shape is designed so Phase 2 can add query params without breaking the client.

**RefundModal:** gains a reason field, and a restock checkbox that appears only when the refund is full (per §3).

**Screen cache:** the list stays cached as today; the detail fetch seeds from the already-cached row (header paints instantly) and revalidates. No new WARM_TARGETS entry (detail is per-id, not a warmable tab).

## 7. Error handling

- Fulfill validates per-line remaining quantity server-side; concurrent fulfillments are safe because quantities are re-checked inside the write transaction.
- Cancel-with-refund is a two-step (refund, then transition): if the refund succeeds and the transition loses a CAS race, the action replays idempotently to convergence; the order is never left refunded-but-uncancelled silently (error surfaces with state).
- Inventory reserve failure at checkout returns a structured per-line "insufficient stock" error the storefront can render.
- Email failures never fail the parent action; they log and skip the timeline event.

## 8. Testing & verification

- Unit tests (vitest, colocated like `campaign-creative-status.test.ts`): state-machine transition table additions; fulfillment coverage math (partial → full, over-fulfil rejection); cancel semantics matrix (state × refund × restock); detail-DTO timeline merge ordering.
- Manual end-to-end on the local dev server (existing recipe): checkout reserves → pay → stock decrements → fulfill with tracking → shipping email → partial refund with restock → cancel path on a fresh checkout.
- Standard gate: `/code-review`, typecheck, lint, build; migrations applied to prod via supabase MCP with the slug-diff + object-existence check (migration-drift lesson).

## 9. Rollout

- Isolated worktree `feat/orders-core` off `origin/main` (never on top of in-flight branches).
- Sequential PRs, each independently gated: **(1)** refund restock + refund-reason UI + agentic reserve, **(2)** fulfillment/cancel spine + tables + emails, **(3)** order detail page + list changes + modals.
- Prod migrations land with their PR, verified by object existence.
