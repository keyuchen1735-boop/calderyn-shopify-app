# Orders Power Tools (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Server-side search/filter/sort/pagination over the unified order list, saved views, bulk actions, CSV export, and printable packing slips/invoices — per the spec's Phase 2 section (`docs/superpowers/specs/2026-07-09-orders-close-out-design.md`).

**Architecture:** One SQL function (`list_orders_unified`) is the read model everything else consumes: the new list route, the export, and the UI toolbar. Bulk actions loop the Phase 1 executors with derived idempotency keys. Print pages are non-SPA full-page routes over the Phase 1 detail read model.

**Tech Stack:** Same as Phase 1. Branch `feat/orders-power-tools` (stacked on `feat/orders-detail-ui`), one PR (4/4) stacked on #403.

## Global Constraints

- Everything in the Phase 1 plan's Global Constraints applies verbatim (frozen files, RLS pattern, `requireDashboardSession`/`requireSameOrigin`, cd-* primitives, CDIcon-only icons, no em dashes in copy, integer cents, unique migration prefixes `20260709xxxxxx`/`20260710xxxxxx`).
- **Pagination is OFFSET-based** (`p_offset`/`p_limit`), not cursor — it supports all three sorts uniformly and the scale (thousands of rows/shop) tolerates it. `p_limit` ≤ 100 in the route; export uses 1000/page (PostgREST clamps every response at 1000 rows — larger limits silently truncate).
- Fulfillment-status filter EXCLUDES imported rows (they have no fulfillment concept). Bulk actions are native-only, ≤25 ids. Bulk tags is ADDITIVE-only. Bulk fulfill carries NO tracking/carrier.
- The print route is opened with `window.open`, never `app.navigate`.

---

### Task 1: migration — `order_view` table + `list_orders_unified` RPC

**Files:**
- Create: `supabase/migrations/20260710090000_orders_list_unified.sql`
- Create: `app/lib/order/unified-list.server.ts` (thin TS wrapper) + `app/lib/order/unified-list-types.ts` (browser-safe types)
- Test: `app/lib/order/unified-list.server.test.ts` (wrapper param mapping via rpc-spy Builder mock)

**Interfaces (produces):**

```ts
// unified-list-types.ts
export interface UnifiedOrderRow {
  source: "calderyn" | "shopify";
  id: string; ref: string;
  buyerEmail: string | null;
  totalCents: number; currency: string;
  paymentStatus: string;            // financial_status both sides; native fallback "pending"
  state: string;                    // imported rows carry financial_status here (badge convention)
  cancelledAt: string | null; archivedAt: string | null;
  occurredAt: string;
  itemCount: number;
  tags: string[];
  remainingRefundableCents: number; // native ledger lateral; imported 0
}
export interface UnifiedOrdersPage { rows: UnifiedOrderRow[]; totalCount: number; offset: number; limit: number }
export interface OrdersListParams {
  search?: string;
  paymentStatus?: string[];         // e.g. ["paid","partially_refunded"]
  fulfillmentStatus?: "unfulfilled" | "partially_fulfilled" | "fulfilled";
  source?: "calderyn" | "shopify";
  dateFrom?: string; dateTo?: string;   // ISO
  tag?: string;
  archived?: boolean;               // default false = exclude archived
  sort?: "date" | "total" | "customer";
  dir?: "asc" | "desc";             // default desc
  offset?: number; limit?: number;  // default 0 / 50
}
// unified-list.server.ts
export async function listOrdersUnified(shopId: string, params: OrdersListParams): Promise<UnifiedOrdersPage>
```

- [ ] **Step 1: Write the migration.** Complete SQL (implementer transcribes verbatim; column names verified against live schema during Phase 1):

```sql
-- supabase/migrations/20260710090000_orders_list_unified.sql
-- Phase 2 list power tools: merchant-saved list views + the unified list read
-- model (native orders UNION imported Shopify history) that search/filter/sort/
-- pagination, CSV export, and the toolbar all consume. Shop-scoped throughout.

-- 1) Saved views.
create table if not exists public.order_view (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  name text not null check (length(name) between 1 and 60),
  filters jsonb not null default '{}'::jsonb,
  position int not null default 0,
  created_at timestamptz not null default now(),
  unique (shop_id, name)
);
alter table public.order_view enable row level security;
create policy order_view_shop_scope on public.order_view
  for all using (shop_id = public.current_shop_id()) with check (shop_id = public.current_shop_id());
revoke all on table public.order_view from anon, authenticated;

-- 2) Unified list. Fulfillment filter EXCLUDES imported rows (no fulfillment
-- concept there); archived filter is native-only by construction (imported rows
-- have no archived_at and always pass unless p_archived filters them out — they
-- pass the default view). One page + the true total via count(*) over ().
create or replace function public.list_orders_unified(
  p_shop_id uuid,
  p_search text default null,
  p_payment_status text[] default null,
  p_fulfillment_status text default null,
  p_source text default null,
  p_date_from timestamptz default null,
  p_date_to timestamptz default null,
  p_tag text default null,
  p_archived boolean default false,
  p_sort text default 'date',
  p_dir text default 'desc',
  p_offset int default 0,
  p_limit int default 50
) returns table (
  source text, id uuid, ref text, buyer_email text,
  total_cents bigint, currency text, payment_status text, state text,
  cancelled_at timestamptz, archived_at timestamptz, occurred_at timestamptz,
  item_count bigint, tags text[], remaining_refundable_cents bigint, full_count bigint
) language sql stable set search_path = '' as $$
  with unified as (
    select
      'calderyn'::text as source,
      o.id,
      '#' || upper(left(replace(o.id::text, '-', ''), 8)) as ref,
      b.email_normalized as buyer_email,
      o.total_cents::bigint as total_cents,
      o.currency,
      coalesce(o.financial_status, 'pending') as payment_status,
      o.state,
      o.cancelled_at,
      o.archived_at,
      o.created_at as occurred_at,
      coalesce((select sum(l.quantity) from public.order_line l
                where l.shop_id = o.shop_id and l.order_id = o.id), 0)::bigint as item_count,
      coalesce((select array_agg(t.tag order by t.tag) from public.order_tag t
                where t.shop_id = o.shop_id and t.order_id = o.id), '{}'::text[]) as tags,
      greatest(coalesce((select sum(tl.amount_cents) from public.transaction_ledger tl
                where tl.shop_id = o.shop_id and tl.order_ref = o.id::text
                  and tl.kind in ('capture','refund')), o.total_cents), 0)::bigint as remaining_refundable_cents
    from public.orders o
    left join public.buyer_dim b on b.shop_id = o.shop_id and b.id = o.buyer_id
    where o.shop_id = p_shop_id
      and o.channel <> 'test'
      and (o.state <> 'checkout_pending' or o.created_at >= now() - interval '1 hour')
    union all
    select
      'shopify'::text,
      io.id,
      coalesce(io.order_number, '#' || upper(left(replace(io.id::text, '-', ''), 8))),
      b2.email_normalized,
      io.total_cents::bigint,
      io.currency,
      coalesce(io.financial_status, 'pending'),
      coalesce(io.financial_status, 'pending'),  -- state carries financial status (badge convention)
      null::timestamptz, null::timestamptz,
      coalesce(io.processed_at, now()),
      coalesce((select sum(il.quantity) from public.imported_order_line il
                where il.shop_id = io.shop_id and il.imported_order_id = io.id), 0)::bigint,
      '{}'::text[],
      0::bigint
    from public.imported_order io
    left join public.buyer_dim b2 on b2.shop_id = io.shop_id and b2.id = io.buyer_id
    where io.shop_id = p_shop_id
  )
  select u.*, count(*) over ()::bigint as full_count
  from unified u
  where (p_source is null or u.source = p_source)
    and (p_payment_status is null or u.payment_status = any (p_payment_status))
    and (p_fulfillment_status is null or (u.source = 'calderyn' and (
          (p_fulfillment_status = 'unfulfilled' and u.state = 'paid')
          or (p_fulfillment_status = 'partially_fulfilled' and u.state = 'partially_fulfilled')
          or (p_fulfillment_status = 'fulfilled' and u.state = 'fulfilled'))))
    and (case when p_archived then (u.source = 'calderyn' and u.archived_at is not null)
              else (u.source = 'shopify' or u.archived_at is null) end)
    and (p_date_from is null or u.occurred_at >= p_date_from)
    and (p_date_to is null or u.occurred_at <= p_date_to)
    and (p_tag is null or lower(p_tag) = any (select lower(x) from unnest(u.tags) x))
    and (p_search is null or p_search = '' or
         u.ref ilike '%' || replace(p_search, '#', '') || '%'
         or u.buyer_email ilike '%' || p_search || '%'
         or lower(p_search) = any (select lower(x) from unnest(u.tags) x))
  order by
    case when p_sort = 'total' and p_dir = 'desc' then u.total_cents end desc nulls last,
    case when p_sort = 'total' and p_dir = 'asc' then u.total_cents end asc nulls last,
    case when p_sort = 'customer' and p_dir = 'desc' then u.buyer_email end desc nulls last,
    case when p_sort = 'customer' and p_dir = 'asc' then u.buyer_email end asc nulls last,
    case when p_sort = 'date' and p_dir = 'asc' then u.occurred_at end asc,
    u.occurred_at desc,
    u.id desc
  offset greatest(p_offset, 0)
  limit least(greatest(p_limit, 1), 1000)
$$;
```

  Archived truth table (already encoded in the case expression — verify, don't change): `p_archived=false` → native unarchived + all imported; `p_archived=true` → native archived ONLY, no imported.
- [ ] **Step 2:** Read the final SQL once against the truth table above and the fulfillment-filter rule before committing.
- [ ] **Step 3:** TS wrapper `listOrdersUnified` mapping params → rpc args and rows → `UnifiedOrderRow` (snake→camel; `full_count` → `totalCount` from the first row, 0 when empty). Wrapper test with an rpc-spy asserting arg mapping + empty-page handling.
- [ ] **Step 4:** Controller applies the migration to prod + smoke query (`select * from list_orders_unified('<peak&pine shop id>'::uuid) limit 3;` sanity + a filtered call). NOT the implementer.
- [ ] **Step 5:** Commit — `db/orders: order_view + list_orders_unified read model`

### Task 2: list + saved-views API routes + client fetchers

**Files:**
- Create: `app/routes/dashboard.api.orders.list.tsx` (GET; query params mirror `OrdersListParams`; validates enums/ints; ≤100 limit)
- Create: `app/routes/dashboard.api.orders.views.tsx` (GET list / POST create `{name, filters}` / DELETE `?id=` — same-origin on writes; validate name 1-60, filters is a flat object of known keys only, ≤20 saved views per shop)
- Modify: `app/lib/dashboard/orders-client.ts` (`fetchOrdersList(params) → UnifiedOrdersPage`, `fetchOrderViews`, `createOrderView`, `deleteOrderView`)
- Test: route tests following `app/routes/__tests__/dashboard.api.orders.detail.test.ts` conventions (param validation 422s, happy paths with mocked wrapper, views CRUD round-trip, cross-origin rejection on writes)

**Interfaces:** `GET /dashboard/api/orders/list?search=&payment_status=a,b&fulfillment_status=&source=&date_from=&date_to=&tag=&archived=&sort=&dir=&offset=&limit=` → `{ rows, total_count, offset, limit }` (snake_case). Views: `{ views: [{id, name, filters, position}] }`.

Steps: TDD → implement → `npx vitest run app/routes app/lib/dashboard` + typecheck + eslint → commit `orders/api: unified list + saved views routes`.

### Task 3: bulk action routes + additive tag helper

**Files:**
- Modify: the existing tags helper module (`app/lib/order/tags.ts` or wherever Phase 1 put `normalizeTags` — find it first): add `addOrderTags(shopId, orderId, addTags: string[]): Promise<string[]>` (union of existing + requested, normalized like the replace helper, cap 20)
- Create: `app/routes/dashboard.api.orders.bulk.fulfill.tsx`, `...bulk.archive.tsx`, `...bulk.tags.tsx`
- Modify: `vercel.json` (add `maxDuration: 60` entries for `app/routes/dashboard.api.orders.bulk.fulfill.tsx` and the Task 4 export route — copy the existing functions-block syntax exactly)
- Modify: `app/lib/dashboard/orders-client.ts` (`bulkFulfillOrders`, `bulkArchiveOrders`, `bulkAddOrderTags` — each returns `{ results: {orderId, ok, error?}[] }`)
- Test: route tests (25-cap 422, imported-id 422, per-order partial-failure array, derived keys `${key}:${orderId}` asserted via executor mock, additive tags never remove)

**Behavior:** validate body (`order_ids` array of 1-25 uuid strings, no `shopify:` prefixes), loop in `Promise.allSettled` batches of 5: fulfill → `executeFulfillAction(shopId, { orderId, notify, idempotencyKey: \`${key}:${orderId}\` })` (no lines/tracking/carrier); archive → the same shop-scoped `archived_at` update the single route uses (extract a tiny shared helper rather than duplicating); tags → `addOrderTags`. Map each settled result to `{order_id, ok, error?}` (CalderynError message; never throw the whole route for one order). Commit `orders/api: bulk fulfill/archive/tags (additive)`.

### Task 4: CSV export route

**Files:**
- Create: `app/routes/dashboard.api.orders.export.tsx` (GET, same query params as the list route)
- Test: route test asserting header row, escaping (fields with commas/quotes/newlines), filter passthrough, cap marker

**Behavior:** `requireDashboardSession`; loop `listOrdersUnified` with `limit: 1000` pages until exhausted or 10,000 rows; build CSV (RFC-4180 escaping — a tiny local `csvField()` helper); final row `"export truncated at 10000 rows"` in the ref column when capped. Response headers: `Content-Type: text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="orders-export-<yyyy-mm-dd>.csv"`. Columns: ref, date (ISO), source, customer, total (decimal), currency, payment_status, fulfillment_status (native state or empty), items, tags (semicolon-joined), cancelled (yes/empty), archived (yes/empty). Commit `orders/api: filtered CSV export`.

### Task 5: printable packing slip + invoice route

**Files:**
- Create: `app/routes/dashboard.orders.print.$id.tsx`
- Test: none automated beyond typecheck (full-page HTML route; e2e covers it) — but add a loader test if the route-test harness makes it cheap (404 unknown id, doc param validation)

**Behavior:** loader: `requireDashboardSession` → `loadOrderDetail(shopId, params.id)` → 404 when null; `doc` query param `packing-slip` (default) | `invoice` (422 otherwise). Default-export component renders a minimal print-stylesheet page (inline `<style>`, no dashboard chrome, no external assets): shop header (session shopDomain or "Order"), order ref + date, shipping address; packing slip = items table (title, sku, qty) NO prices; invoice = items with unit price + line totals, payment breakdown (subtotal/shipping/tax/total, refunded when > 0). A small `window.print()` button hidden under `@media print`. No em dashes; no provenance. Commit `dashboard/orders: printable packing slip + invoice`.

### Task 6: Orders screen rework (toolbar, tabs, pagination, bulk bar)

**Files:**
- Create: `app/components/dashboard/screens/OrdersToolbar.tsx` (search/filters/sort/views UI, controlled by a `ListState` object)
- Modify: `app/components/dashboard/screens/Orders.tsx` (swap the merged-list data flow for `fetchOrdersList`; pagination footer; checkboxes + bulk bar; keep detail branch, drafts/abandoned/labels tabs untouched)
- Modify: `app/lib/dashboard/screen-cache.ts` + `app/lib/dashboard/prefetch.ts` (new `SCREEN_CACHE_KEYS.ordersList`; WARM_TARGETS: add the default-view list fetch, remove the importedOrders entry — first verify nothing else warms from it)
- Test: extend `order-status.test.ts`-style pure helpers if any new pure logic emerges (e.g. `filtersToParams` for saved views) with a colocated test

**Behavior contract:**
- `ListState = { view: "all" | "unfulfilled" | "unpaid" | "archived" | <savedViewId>, search, filters..., sort, dir, offset }`; system tabs map to fixed params (unfulfilled → fulfillmentStatus=unfulfilled; unpaid → paymentStatus=[pending,authorized,partially_paid]; archived → archived=true); saved views spread their stored filters.
- Default view (all, no filters, offset 0) seeds from + writes through the screen cache; any other state fetches live (no cache writes).
- Search input debounced 300ms; every state change resets offset to 0 except explicit paging.
- Rows keep Phase 1 behavior (click → detail, Refund button off `remainingRefundableCents`); map `UnifiedOrderRow` → the existing `DisplayOrder` shape so `UnifiedOrdersList`'s row rendering survives with minimal edits (imported rows: `shopify:` prefix ids, no fulfillment badge).
- Checkbox column (native rows only — imported rows show a dash), header select-page checkbox; bulk bar shows count + Fulfill / Archive or Unarchive (per current view) / Add tag (small inline input) + Export CSV button (always visible in the toolbar, uses current filters via `window.open` on the export URL).
- Bulk completion toast: "N fulfilled." or "N of M fulfilled. K failed." (list failures' refs in a second warn toast when ≤3, else "Check the orders.").
- Print buttons: on the DETAIL screen action bar overflow — "Print packing slip" / "Print invoice" via `window.open('/dashboard/orders/print/<id>?doc=...')`.
- Pagination footer: `Showing X-Y of N` + Prev/Next `Btn small` (disabled at bounds).

Steps: implement → `npx vitest run app/components` + typecheck + eslint + build → commit `dashboard/Orders: search, filters, saved views, pagination, bulk actions`.

### Task 7: gate + e2e + PR 4

- [ ] Full gate (typecheck, lint, build, full vitest).
- [ ] Browser e2e against prod DB (same recipe as Phase 1: minted session on the Peak & Pine shop, `DASHBOARD_ALLOWED_ORIGINS=http://localhost:3000`): search by ref + email; each filter; Unfulfilled/Unpaid/Archived tabs; save + delete a custom view; paginate past 50; select 2 orders → bulk add-tag (verify additive), bulk archive + unarchive; bulk fulfill 2 paid orders (notify off) → states flip; CSV export downloads with the active filter; packing slip + invoice pages render print-ready. Revoke the session after.
- [ ] Final review (whole-diff, most capable model) → fix wave → re-verify.
- [ ] Push `feat/orders-power-tools`, `gh pr create --base feat/orders-detail-ui` titled `dashboard/orders: list power tools — search, views, bulk, export, print (phase 2, PR 4)`.
- [ ] Ledger + memory updates.
