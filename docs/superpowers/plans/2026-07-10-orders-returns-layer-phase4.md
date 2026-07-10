# Orders Returns + Calderyn Layer (Phase 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merchant-recorded returns with restock + refund, exchange-lite, profit-per-order, order signals, and Ask Calderyn order tools — per the spec's Phase 4 section (adversarially verified; the COGS/fee/carrier factual corrections are binding).

**Architecture:** Returns follow the edit-executor discipline exactly (idempotency lanes, resume, over-refund pre-check, CAS status flips). Profit is a detail-page read model over data that mostly must be newly plumbed (cost snapshots). Signals are read-time (one bulk buyer aggregate on detail; zero-cost stuck badge on list). Assistant tools ride the existing registry (writes) + dispatcher (reads with a new compact projection).

**Tech Stack:** Same as Phases 1-3. Branch `feat/orders-returns-layer` (carries the already-PR'd UI-polish commits — keep them; the PR diff resolves once #420 merges). One PR (6).

## Global Constraints

- All prior Global Constraints apply (RLS pattern, same-origin writes, executor idempotency conventions, cd-*/CDIcon, no em dashes, integer cents, unique migration prefixes).
- Binding verifier facts: NO cost-snapshot pipeline exists anywhere (all population paths are new); NO real Stripe processing-fee data exists (fees are ALWAYS the labeled 2.9% + 30¢ estimate); `shipping_invoice_line.matched_order_id` FKs to `order_fact(id)` and is 1:many (SUM/GROUP BY required); native paid orders DO emit `order_fact` rows via `emitPaidOrder` (verify the external-gid linkage shape when joining); buyer-history signals MUST use the bulk-aggregate-then-fold pattern (`app/lib/buyer/directory.server.ts` `purchaseAggregates`), never per-row correlated subqueries; assistant read tools require edits to `READ_TOOLS` + the dispatcher switch in `app/lib/assistant/tools.server.ts` while write tools drop into `ASSISTANT_ACTIONS` with zero core edits; `issue_refund`/`cancel_order` assistant actions already exist — do not duplicate.
- Returns quantities: returnable = fulfilled − previously-received-returns; reductions and shipments are disjoint pools (edit guard enforces newQty ≥ fulfilled).

---

### Task 1: migration + return executors

**Files:**
- Create: `supabase/migrations/20260710210000_order_returns.sql` — `order_return` + `order_return_line` per the spec (composite FKs to orders/order_line, RLS+revoke both tables, unique partial index `order_return_one_open on (shop_id, order_id) where status = 'open'`, status check open/received/closed/cancelled, `received_idempotency_key text`), plus `alter type public.action_kind add value if not exists 'return_received';` and `alter table public.order_line add column if not exists unit_cost_cents_snapshot int;` (Task 3 consumes it; one migration keeps the prefix budget tidy) and the backfill: `update public.order_line ol set unit_cost_cents_snapshot = v.unit_cost_cents from public.variant_dim v where v.id = ol.variant_id and v.shop_id = ol.shop_id and ol.unit_cost_cents_snapshot is null and v.unit_cost_cents is not null;`
- Create: `app/lib/order/returns.server.ts` — `createOrderReturn(shopId, input)`, `cancelOrderReturn(shopId, returnId)`, `executeReturnReceivedAction(shopId, { returnId, idempotencyKey, actor })`, `listOrderReturns(shopId, orderId)` (+ browser-safe types in `app/lib/order/returns-types.ts`)
- Modify: `app/lib/order/detail.server.ts` (returns in the DTO + timeline events), `app/lib/labels.ts`/`app/lib/types.ts` (action kind), checkout + invoice send paths to POPULATE `unit_cost_cents_snapshot` on new order_line rows (read where line rows are built in `checkout.server.ts` + `invoice.server.ts`; the variant cost is available at pricing time — thread it; if priceCart doesn't expose cost, extend its select minimally)
- Tests: full executor matrix (create validations incl. one-open guard 409 + per-line max; receive: replay, resume after crash-before-audit, over-refund 409 BEFORE any write, restock per line keyed `restockreturn:<lineId>`, refund sub-key, CAS status flip loses → converges; cancel only when open), snapshot population tests (checkout + invoice lines carry cost), detail DTO returns card + events.

**executeReturnReceivedAction flow (binding):** replay via priorExecutionForKey → load return (status open, CAS later) + lines + order → over-refund pre-check (Σ refund_cents ≤ remainingRefundableByOrder) → per-line restock where restock=true (tracked only) → refund Σ refund_cents when > 0 via executeRefundAction(`${key}:refund`, restock false) → stamp received_at + received_idempotency_key, status → 'received' then 'closed' via a single update with `.eq("status","open")` CAS (0 rows → re-read: if received/closed by a concurrent retry, treat as replay-converged) → audit row action_kind 'return_received' (params: return_id, order_id snake_case, refunded_cents, restocked_lines).

### Task 2: returns routes + UI

**Files:**
- Create: `app/routes/dashboard.api.orders.$id.returns.tsx` (GET list / POST create `{ lines: [{order_line_id, quantity, restock, refund_cents?}], reason? }` — server recomputes default refund_cents (unit price + proportional tax share, reusing the Task-3 shared tax fixture formula) and caps client-supplied values at the default; validation mirrors reduce-line), `...returns.receive.tsx` (POST `{ return_id, idempotency_key }`), `...returns.cancel.tsx` (POST `{ return_id }`)
- Create: `app/components/dashboard/screens/CreateReturnModal.tsx` (line picker: per-line returnable qty shown, restock checkbox per line default ON, editable refund per line capped at default, total refund preview; confirm copy notes refund happens at Mark received)
- Modify: `OrderDetail.tsx` — "Create return" action (visible when native && any line has returnable qty && no open return), Returns card (status, lines, Mark received / Cancel return buttons with confirm, "Create replacement order" on received/closed returns → navigates to the composer prefilled: pass the lines via nav state or a query the composer reads — smallest mechanism, document it; the new order's send path stamps attribution {exchange_for} — thread through sendDraftOrderInvoice input), timeline renders return events; `orders-client.ts` wrappers.
- Exchange copy (exact): "The refund and the replacement order are separate transactions. The customer is refunded for the return and pays for the replacement normally."
- Tests: route validations + per-line cap; UI pure helpers (returnable-qty math) colocated.

### Task 3: profit read model + card

**Files:**
- Create: `app/lib/order/profit.server.ts` — `orderProfit(shopId, orderId): Promise<OrderProfit>` per the spec (revenue from ledger; COGS via effective qtys × snapshots with `costsMissing` count; carrier via order_fact linkage — READ `app/lib/order/emit.server.ts` for the native external-gid shape and the ship-cost matcher (`app/lib/ship-cost/` or grep shipping_invoice_line writers) to join correctly, SUM grouped; fees = estimate only, labeled; margin %). Browser-safe `OrderProfit` type.
- Create: `app/routes/dashboard.api.orders.$id.profit.tsx` (GET) + client wrapper.
- Modify: `OrderDetail.tsx` — Profit card (Revenue / COGS / Carrier cost / Payment fees (estimated) / Ad attribution source line / Profit + margin %; "cost data incomplete" and "no carrier cost recorded" states; imported orders label costs estimated).
- Tests: profit math matrix (full data, missing costs, refunds netted, no carrier match, fee floor), route, imported-order variant.

### Task 4: order signals

**Files:**
- Modify: `supabase/migrations/` — NONE (read-time only). `list_orders_unified` NOT touched.
- Modify: `app/lib/order/detail.server.ts` (or a small `signals.server.ts`): buyer aggregate via ONE query over the buyer's orders + refund ledger following `purchaseAggregates`' fold pattern → `{ repeatCustomer, orderCount, refundRatio, refundRisk }`; `stuckUnfulfilled` derived from state+age. DTO gains `signals`.
- Modify: `Orders.tsx` (stuck badge on rows where state paid && >3d — the row data already has occurredAt/state; a small pure helper + test), `OrderDetail.tsx` (signals strip: plain labels "Repeat customer (4 orders)", "High refund history", "Unfulfilled for 5 days" — quiet pills, no alarm styling).
- Optional (only if trivially additive after reading `app/routes/api.detectors.run.tsx`): a stuck-orders TS detector emitting the existing alert shape; otherwise note deferred in the report.
- Tests: signal math (thresholds, guest buyers, single-order buyers), pure list-badge helper.

### Task 5: assistant order tools

**Files:**
- Modify: `app/lib/assistant/tools.server.ts` (READ_TOOLS + dispatcher switch: `search_orders`, `get_order`) — read the CURRENT file conventions first (result shapes, LIMIT_CAP, error style); compact projections defined in the spec are binding (search ≤20 rows; get_order: header/money/lines(title,qty,effective)/latest 5 timeline titles/signals; buyer email MASKED like m***@domain).
- Modify: the write registry (`app/lib/assistant/catalog-actions.server.ts` or wherever ASSISTANT_ACTIONS lives — grep): `fulfill_order` (params order_id, notify default false; CONFIRM tier — read how existing confirm-tier actions declare it; validate against executeFulfillAction), `add_order_note` (order_id, body ≤2000), `add_order_tags` (order_id, tags additive via addOrderTags). Wire shopId the way sibling actions do.
- Tests: mirror the existing assistant tool tests (grep the test files for registry/dispatcher coverage patterns): projection shapes (no unmasked email, ≤5 timeline entries), tool validation, confirm-tier declared on fulfill, additive tags asserted.

### Task 6: gate + e2e + final review + PR 6

- Full gate (typecheck, lint, build, full vitest).
- Prod migration applied + verified (controller).
- Browser e2e vs prod DB: create return on the fulfilled e2e order (1 unit) → Mark received (refund will 409 on demo no-PI orders → verify the error surfaces and the return stays open/consistent — receive must be all-or-nothing-visible; alternatively set refund_cents 0 on the line to exercise the restock+close path cleanly) → Returns card + timeline; replacement-order prefill opens composer; Profit card renders with flags on a native order + the invoice order; signals strip + stuck badge (seed check); assistant tools smoke via the assistant panel if feasible, else route-level curl with a minted session.
- Final whole-branch review (most capable model) → fix wave → re-verify.
- Push, PR 6 vs main (rebase if #420 merged so the diff excludes polish), ledger + memory + final report to the user with the full Orders close-out status.
