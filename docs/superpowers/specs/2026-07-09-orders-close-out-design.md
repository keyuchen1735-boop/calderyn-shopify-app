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

---

# Phase 2 — list power tools (designed 2026-07-09 after Phase 1; adversarially verified, revisions folded in)

## 1. Unified list read model (the foundation)

**SQL function `list_orders_unified(...)`** (plain function, `set search_path=''`, service-role called, shop_id always bound) UNIONs native `orders` (excluding `channel='test'`, excluding stalled `checkout_pending` past the 1-hour abandon cutoff, exactly like today's `listOrders`) and `imported_order` into one row shape:

- `source` ('calderyn' | 'shopify'), `id`, `ref` (native: first-8 hex of the uuid, uppercased; imported: `order_number`), `buyer_email` (`buyer_dim` join on both — imported rows use their relinked `buyer_id`, which finally gives migrated history a customer column), `total_cents`, `currency`, `payment_status` (both sides' `financial_status`; native falls back to 'pending'), `state` (imported rows carry their financial status here, mirroring the shipped client convention so the fulfillment badge stays native-only), `cancelled_at`/`archived_at` (native only, null for imported), `occurred_at` (`created_at` vs `processed_at`), `item_count` (lateral sum), `tags` (native lateral array_agg; empty for imported), `remaining_refundable_cents` (native lateral over `transaction_ledger` capture/refund sums, gross-total fallback — the list row's Refund button depends on it), `full_count` (`count(*) over ()`).

**Parameters:** `p_search` (matches ref prefix — native via `replace(id::text,'-','')`, imported via `order_number` — OR buyer email substring OR exact tag, case-insensitive), `p_payment_status[]`, `p_fulfillment_status` ('unfulfilled' | 'partially_fulfilled' | 'fulfilled'), `p_source`, `p_date_from/to`, `p_tag`, `p_archived` (default excludes archived), `p_sort` ('date' | 'total' | 'customer', asc/desc), `p_offset` + `p_limit` (≤100; UI uses 50).

**Fulfillment-filter rule (explicit):** a fulfillment-status filter EXCLUDES imported rows — they carry no fulfillment concept, and the filter's job is a work queue. The UI notes this next to the control. Native mapping: unfulfilled = state 'paid' with no coverage; partially_fulfilled / fulfilled = their states.

## 2. Saved views

New `order_view` table (id, shop_id, name 1-60, filters jsonb, position, created_at; RLS shop_scope + revoke, unique (shop_id, name)). System preset tabs are code, not rows: All / Unfulfilled / Unpaid / Archived. CRUD: list+create+delete (rename = delete+create; no edit-in-place in phase 2).

## 3. Bulk actions (native orders only, ≤25 ids per call)

- `POST dashboard.api.orders.bulk.fulfill` — body `{ order_ids, notify, idempotency_key }`. NO tracking/carrier fields — bulk fulfill is "mark all remaining lines shipped" only; tracking entry stays per-order in FulfillModal (one tracking number must never be stamped on 25 shipments).
- `POST dashboard.api.orders.bulk.archive` — `{ order_ids, archived }`.
- `POST dashboard.api.orders.bulk.tags` — `{ order_ids, add_tags }` — ADDITIVE ONLY via a new union helper (existing ∪ add_tags, capped at 20). The single-order full-replace route is never used for bulk (silent tag wipe-out).
- Each loops the existing audited executors/helpers with derived per-order keys `${idempotency_key}:${orderId}`, parallel batches of 5, and returns a per-order result array `{ order_id, ok, error? }` — partial failure is normal output, and a client retry with the same key is idempotent per order.
- `vercel.json` gains `maxDuration: 60` for the two mutation-heavy routes (bulk.fulfill and export); default budgets are too thin for 25 executor loops.

## 4. CSV export

`GET dashboard.api.orders.export` honoring the exact list filters; loops `list_orders_unified` pages of **1000** (PostgREST clamps every response at 1000 rows — a larger p_limit silently truncates), 10k row cap with a truncation marker row, streams `text/csv` as an attachment. Columns: ref, date, source, customer, total, currency, payment status, fulfillment status, item count, tags, cancelled, archived.

## 5. Printable packing slips + invoices

`app/routes/dashboard.orders.print.$id.tsx` — full-page NON-SPA route (`requireDashboardSession`), `?doc=packing-slip|invoice`, rendered from the existing `loadOrderDetail`, minimal print-friendly inline-styled HTML (no dashboard chrome), browser print → PDF. **Opened via `window.open`/`target=_blank` only** (the po.pdf precedent) — never `app.navigate`; the SPA router cannot and should not parse this path. Packing slip: items + quantities + shipping address, no prices. Invoice: items with prices, payment breakdown, shop name. Print buttons live on the order detail screen.

## 6. UI (Orders screen rework)

- Toolbar above the list: debounced search input, filter controls (payment status, fulfillment status, source, date range), sort menu, view tabs (system presets + saved views with a "Save current view" affordance + per-view delete).
- Pagination footer ("1-50 of N", prev/next).
- Row checkboxes + select-page; bulk bar (Fulfill, Archive/Unarchive, Add tag) appears on selection with per-order failure reporting in the completion toast.
- **Data flow + cache (explicit):** a NEW `GET dashboard.api.orders.list` route wraps the RPC; the old bundle endpoint (`dashboard.api.orders`) keeps serving drafts/abandoned/shipCharges for the other subtabs (its `orders` field stays for back-compat but the screen stops reading it). `fetchImportedOrders` leaves the Orders screen (endpoint kept — other consumers unaffected). Screen cache: the DEFAULT view's first page seeds + writes through under a new `SCREEN_CACHE_KEYS.ordersList`, with a matching `WARM_TARGETS` swap (list default view replaces the importedOrders warm entry); filtered/paged results are fetched live, never warm-cached.
- The detail screen, modals, drafts/abandoned/ship-charges tabs are untouched.

## 7. Rollout

Branch `feat/orders-power-tools` stacked on `feat/orders-detail-ui`; one PR (4/4 of this train) stacked on #403. Migration applied to prod with object verification before the PR opens. Same gate as Phase 1.

---

# Phase 3 — create & edit + recovery (designed 2026-07-10; adversarially verified, 9 revisions folded in)

## 1. Merchant-created orders (invoices)

- **Composer:** "Create order" from the Orders screen: catalog variant picker with search, quantities, customer email, optional shipping address + note. The draft persists as a `cart` row with new nullable column `cart.origin = 'merchant_draft'` (buyer baskets have origin null). `listDraftCarts` explicitly excludes merchant drafts; a Drafts affordance in the composer lists them.
- **Send invoice** (`sendDraftOrderInvoice`): snapshot-price the lines, quote shipping+tax via `quoteCart` when an address exists, insert an `orders` row (`channel: 'invoice'`, born `checkout_pending`, confirmation token), snapshot `order_line`, mark the cart consumed, email the customer an invoice (new notify-email sender: line summary, total, pay link). **No inventory hold at send** (a 30-minute TTL is meaningless for an invoice).
- **The pay link never embeds a raw Stripe URL** (hosted sessions hard-expire at 24h). It points at a Calderyn route `/storefront/invoice/:token/pay` which, per click, verifies the order is still payable, lazily expires any stale session and creates a fresh hosted Checkout session, then redirects. Paid invoices flow through the normal webhook into the list/detail/fulfill pipeline.
- **Stock on payment:** when `payment_intent.succeeded` finds no reservation for the order, a new atomic RPC `inventory_sale_fallback` (FOR UPDATE, relative decrement, ledger entry `sale`, idempotent per order+variant) decrements tracked lines. Policy: on_hand may go negative (backorder-truth, mirroring the reserve RPC's backorder branch) — honest inventory beats hidden oversell; the inventory screen already displays the number.
- **Reaper exemption (launch-blocking fix):** the abandoned-order reaper must skip `channel = 'invoice'` orders entirely — otherwise it cancels an unpaid invoice at 24h and a later payment is silently stranded (the webhook's recovery path only revives `checkout_pending`). Killing an invoice is a merchant action: **Void invoice** (cancel executor, reason `invoice_void`).
- `listAbandonedCheckouts` gains a `channel <> 'invoice'` filter (a day-old unpaid invoice is not an abandoned checkout).

## 2. Order editing (scoped)

- **Unpaid invoice orders:** edit lines freely → re-snapshot/re-price, totals updated; the pay-link route always reads the current order so no Stripe artifact needs eager updating; optional re-send invoice email.
- **Paid orders: reductions only** (reduce quantity / remove line). Preconditions: native, paid/partially_fulfilled/fulfilled, and `newQty >= that line's fulfilled quantity` (never refund shipped units). Effects, in order: append an `order_line_edit` audit row (new table: order_line_id, old_qty, new_qty, reason, refund_cents, created_at — `order_line` snapshots are NEVER mutated), partial refund of the exact price delta via the existing refund executor, per-line restock of the removed units via a new thin wrapper calling `inventory_restock` directly (the executor's whole-order restock flag only fires on full refunds — not used here), timeline event.
- **Effective quantity** (`quantity − Σ reductions`) becomes the ground truth at three read sites, updated in this phase: the warehouse emit's redelivery re-read (facts keep time-of-sale truth: emitted rows are not retro-rewritten; the netting only guards the redelivery path), the fulfill executor's remaining-math, and the detail read model's line list.
- **Adding items to a paid order is deferred to Phase 4** (it is exchange machinery: collect additional payment, allocate stock).

## 3. Abandoned-checkout recovery

- **Scope:** storefront-originated `checkout_pending` orders only (`channel = 'storefront'`); invoices are re-sent, never "recovered."
- **Send paths:** manual button on Abandoned rows; automatic via cron at ~4 hours abandoned (well before the 24h reap), gated on the buyer's recorded marketing consent (`buyer_consent.policy = 'marketing' AND accepted`). `orders.recovery_email_sent_at` (new column) guarantees at-most-once.
- **Resume link:** keyed by the order's confirmation token → storefront route that rebuilds a FRESH cart from the order's line snapshots via the existing cart primitives (re-priced at the current catalog — `addCartLine` snapshots live prices by design; the email copy says prices reflect current availability), sets the `cd_cart` cookie, redirects to checkout. Works even after the reaper cancels the original order (nothing resurrects the old PI).
- **Attribution:** the new order's attribution carries `recovered_from: <original order id>`; the timeline shows "Recovered from an abandoned checkout."

## 4. Explicit v1 cuts (Shopify parity, deliberate)

Draft-order discounts, mark-as-paid (bypasses the money ledger), payment terms, adding items to paid orders (Phase 4). Nothing half-implements these today; cutting them is clean.

## 5. Rollout

Branch `feat/orders-create-edit` off main; one PR (5). Migrations applied to prod with object verification. Same gate + browser e2e as Phases 1-2.
