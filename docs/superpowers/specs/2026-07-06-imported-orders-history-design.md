# Imported order history (dashboard visibility) — design

Date: 2026-07-06
Owner: John (dashboard lane)
Status: approved (delegated), building

## Problem

"Import from Shopify" reports that it brought over past orders and refunds
(verified in prod: `imported_order` = 3824, `imported_refund` = 90 for
calderyn-review-store, matching the Shopify source 1:1). But no merchant-facing
screen reads those tables. The Orders tab and the commerce/live Analytics read
the native `orders` OLTP spine (real Calderyn checkouts only), so a merchant who
just imported their store sees none of their history. The import promote even
labels these tables "analytics continuity," and the import-map design deferred a
merchant-facing history view as out of scope. This closes that gap.

## The hard constraint (why this is read-only)

Imported orders were paid on the merchant's Shopify payment processor. Calderyn's
refund path (`app/lib/actions/refund.server.ts`) reverses the original Stripe
charge Calderyn made; an imported order has no Calderyn `payment_intent`, so the
code refuses it (422, "refund it in Stripe/Shopify directly"). Calderyn cannot
move money on these orders, and they are historical (already fulfilled on
Shopify). So this feature makes the history VISIBLE and honest; it does not fake
money movement.

## Scope

In:
- A new "Imported" subtab on the Orders screen listing imported orders (order
  number, date, financial status, total, refunded amount) with a summary header
  (order count, gross revenue, refunds, date range).
- Read path only: new server reader, API route, client fetcher, screen-cache
  wiring (seed + write-through + WARM_TARGETS), matching existing conventions.
- Honest labeling: imported orders show their Shopify financial status and a note
  that they are read-only history paid on Shopify.

Out (deliberate, flagged for follow-up):
- Recording a manual refund/adjustment for the books. This is the one real
  "action" possible, but it belongs in a dedicated adjustment table (not the
  import-only `imported_refund`) and must decide whether it feeds engine
  return-rate signals. Needs its own small schema decision, so it is a separate
  increment, not silently bolted on.
- Merging imported history into the main Analytics charts / dashboard headline
  numbers (risk of double-counting native vs mirrored; the warehouse `order_fact`
  already carries this history for the engine).
- Converting still-open cutover orders into the live `orders` spine (needs
  synthetic buyer/payment plumbing the pivot design intentionally rejected).

## Data sources

- `imported_order` (shop-scoped): id, order_number, external_id, financial_status,
  currency, total_cents, processed_at.
- `imported_refund` (shop-scoped): imported_order_id, subtotal_cents (rolled up
  per order and in total).
Both are read with the service-role client threaded by `shop_id`, paginated over
the PostgREST 1000-row clamp (3824 rows needs it).

## Architecture (files)

- `app/lib/order/imported-list-types.ts` — client-safe DTOs
  (`ImportedOrderRow`, `ImportedOrdersSummary`, `ImportedOrdersPage`).
- `app/lib/order/imported-list.server.ts` — `loadImportedOrdersPage(shopId)`:
  paginated reads + a pure `buildImportedOrdersPage(orders, refunds, limit)` that
  computes the summary, rolls up refunds per order, and returns a most-recent
  slice for the table (`RECENT_LIMIT` rows) plus the true `totalCount`.
- `app/lib/order/__tests__/imported-list.server.test.ts` — unit tests over the
  pure builder (summary math, per-order refund rollup, recency slice, empty case).
- `app/routes/dashboard.api.orders.imported.tsx` — GET `/dashboard/api/orders/imported`
  (`requireDashboardSession` + `dashboardJson`).
- `app/lib/dashboard/orders-client.ts` — `fetchImportedOrders()`.
- `app/lib/dashboard/screen-cache.ts` — `SCREEN_CACHE_KEYS.importedOrders`.
- `app/lib/dashboard/prefetch.ts` — WARM_TARGETS entry.
- `app/components/dashboard/screens/Orders.tsx` — "Imported" subtab: summary
  strip + read-only table + honest note; seeded from cache, fetch-on-mount,
  write-through.

## Data flow

Orders screen mounts, seeds `imported` state from the screen cache (warm if the
idle prefetch ran), fetches `/dashboard/api/orders/imported`, writes through the
cache. The subtab renders the summary + recent rows. No mutations.

## Behavior notes

- Summary totals are over ALL imported orders (accurate); the table shows the
  most recent `RECENT_LIMIT` with a "showing most recent N of TOTAL" footer when
  truncated. (Search/pagination is a later add if merchants need to find a
  specific old order.)
- The subtab count badge shows the true total (not the generic "100+" cap), since
  the full count is known from the summary.
- Empty case (no import yet): a placeholder that points to Import from Shopify.

## Testing

- Unit: `buildImportedOrdersPage` — gross/refund/net math, per-order refund
  rollup, first/last date, currency default, recency slice + totalCount, empty
  input.
- Gate: typecheck, lint (max-warnings=0 on new files), build, code-review.
- Verify: drive the real dashboard against prod calderyn-review-store and confirm
  the 3824 orders + 90 refunds render with correct totals.

## Follow-ups (need a nod)

1. Record-refund (bookkeeping) via a dedicated `imported_order_adjustment` table,
   with an explicit decision on whether it feeds engine return-rate.
2. Optional: fold imported history into Analytics via `order_fact` (careful dedup).
