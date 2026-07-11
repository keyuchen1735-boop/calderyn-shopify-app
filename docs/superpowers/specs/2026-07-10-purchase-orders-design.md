# Purchase-order subsystem — design (2026-07-10)

## Problem

Purchase orders today are audit-row snapshots: `create_po_draft` stores a `PoDraft` JSON in
`action_audit.params.po`, and the Purchase orders screen is a filtered view over the shared audit
list. There is no PO entity, no supplier, no ETA, no status lifecycle, and receiving stock against a
PO is impossible. PR #418 explicitly deferred "Real PO subsystem (suppliers/ETA/receive)". This
feature builds it.

## Goals

- Merchant-facing suppliers (shop-scoped) with contact info and a default lead time.
- Real purchase orders: number, supplier, destination location, ETA, lines (variant, qty, unit
  cost), notes, status lifecycle `draft → ordered → partial → received`, plus `cancelled`.
- Receive flow that atomically moves stock `incoming → on_hand` through the existing inventory
  SQL-function pattern and writes `inventory_ledger` rows (`entry_type='receive'` is already
  whitelisted and unused — reserved for exactly this).
- Autopilot's existing restock drafts stay visible and can be promoted into real POs.
- PDF download for real POs (reuse `renderPoPdf`).

## Non-goals

- Emailing POs to suppliers, supplier portals, multi-currency, landed-cost allocation.
- Changing how Autopilot proposes `create_po_draft` (alert/action pipeline untouched).
- Cost-of-goods (`cogs_fact`) writes on receive — deferred; receive only moves stock.

## Data model (one migration, shop-scoped, RLS like existing `*_dim` tables)

### `supplier_dim`
- `id uuid pk default gen_random_uuid()`
- `shop_id uuid not null references shops(id) on delete cascade`
- `name text not null` (unique per shop on `lower(name)`)
- `email text`, `phone text`, `notes text`
- `lead_time_days int check (lead_time_days >= 0 and lead_time_days <= 365)`
- `active boolean not null default true`
- `created_at / updated_at timestamptz not null default now()`

The existing global `supplier` table (viral sourcing, no `shop_id`) is a different concept and is
left untouched. `product_dim.vendor` free text stays as-is; a supplier is not required to save a
product.

### `purchase_order`
- `id uuid pk`, `shop_id uuid not null references shops(id) on delete cascade`
- `po_number text not null`, `unique (shop_id, po_number)`; format `PO-YYYYMMDD-XXXXXXXX`
- `supplier_id uuid references supplier_dim(id)` (nullable), `vendor_name text` (snapshot at
  create so renames/deletes don't rewrite history; required when `supplier_id` is null? No —
  nullable, display falls back to "—")
- `destination_location_id uuid not null references location_dim(id)`
- `status text not null default 'draft' check (status in ('draft','ordered','partial','received','cancelled'))`
- `expected_at date` (ETA; when a supplier with `lead_time_days` is chosen and no explicit ETA is
  given, default it to `today + lead_time_days` at create time, server-side)
- `notes text`
- `source text not null default 'manual' check (source in ('manual','autopilot'))`
- `audit_id uuid` (links a promoted Autopilot draft back to its `action_audit` row; also used to
  hide already-promoted drafts from the drafts list)
- `created_at / updated_at timestamptz not null default now()`, `ordered_at`, `received_at`,
  `cancelled_at timestamptz`

### `purchase_order_line`
- `id uuid pk`, `shop_id uuid not null`, `po_id uuid not null references purchase_order(id) on delete cascade`
- `variant_id uuid references variant_dim(id) on delete set null`; `sku text` and
  `variant_title text` are nullable snapshots, so deleting a catalog variant does not erase or
  block historical PO lines
- `qty_ordered int not null check (qty_ordered > 0 and qty_ordered <= 1000000)`
- `qty_received int not null default 0 check (qty_received >= 0)` (receive fn enforces
  `qty_received <= qty_ordered`)
- `unit_cost_cents int check (unit_cost_cents >= 0)` (nullable = "TBD", same as PoDraft)
- `unique (po_id, variant_id)`

The legacy engine table `purchase_order_draft` (unused by the app except demo reset) is untouched.

## Stock semantics (SQL functions, same style as `20260629160150_inventory_merchant_fns.sql`)

All functions are `security definer`, shop-scoped, `FOR UPDATE` locking, and raise text errcodes the
route maps to 422s (mirror `inventory_receive_transfer`).

- `po_mark_ordered(p_shop_id, p_po_id)` — require `status='draft'` (`po_not_draft`), require at
  least one line (`po_empty`), require destination location active (`location_inactive` — mirrors
  the relocate guard; the transfer path lacks this and we will not repeat that gap). Per line:
  upsert `inventory_balance` at destination, `incoming += qty_ordered`, ledger `in_transit` row with
  `order_ref = po_number`, `reason = 'po_ordered'`, `source='merchant'`, idempotency key
  `po_order:<line_id>`. Set `status='ordered'`, `ordered_at=now()`. A retry while already
  `ordered` recomputes incoming and returns the same affected variants, closing the
  database-commit/projection-failure window.
- `po_receive(p_shop_id, p_po_id, p_lines jsonb, p_receipt_id uuid)` — `p_lines =
  [{line_id, qty}]`; `p_receipt_id` is one client-generated UUID per receive submission and is
  reused for retries. New receipts require `status in ('ordered','partial')`; an exact committed
  receipt replay is also accepted in `received` (`po_not_receivable` otherwise). Per entry: `qty > 0`
  (`invalid_receive_qty`), `qty_received + qty <= qty_ordered` (`receive_exceeds_ordered`); balance:
  `on_hand += qty`; ledger `receive` row, idempotency key
  `po_receive:<receipt_id>:<line_id>`; update line and recompute incoming from PO/transfer truth.
  An exact receipt replay skips already-committed ledger keys but still returns their affected
  variants. The receipt UUID identifies the whole submitted line/quantity set: reusing it with a
  subset, superset, or changed quantity raises `receipt_conflict`; a new submission gets a new
  UUID. An exact replay remains a success after the original call fully received the PO, allowing
  `projectLevelFact` recovery without double-counting stock. After all entries, status becomes
  `received` + `received_at` when every line is fully received, else `partial`.
- `po_cancel(p_shop_id, p_po_id)` — new cancellation requires
  `status in ('draft','ordered','partial')`; `cancelled` is accepted only as a same-state retry
  (`po_not_cancellable`). For ordered/partial, remove remaining expectation:
  `incoming = greatest(incoming - (qty_ordered - qty_received), 0)` per line, ledger `in_transit`
  row with negative qty and `reason='po_cancelled'` (keeps the incoming journal balanced). Received
  stock stays. Set `status='cancelled'`, `cancelled_at`. A retry while already `cancelled`
  recomputes incoming and returns affected variants for projection recovery.

`po_recompute_incoming` first creates and then locks the target `inventory_balance` row before its
recompute `UPDATE`. Concurrent PO operations for the same variant/location therefore serialize
instead of overwriting a newer incoming total. The follow-up migration also adds standalone
indexes for every new foreign-key column not already covered by a leading index.

Draft edits (lines/supplier/ETA) are allowed only in `draft`, so no incoming rebalancing on edit.
After every mutating call the app layer re-projects `inventory_level_fact` via
`projectLevelFact(shopId, variantId, destinationLocationId)` (existing pattern in
`app/lib/inventory/engine.server.ts`).

## Server lib + routes

- `app/lib/po/purchase-orders.server.ts` — DTO shaping + validation + RPC wrappers:
  `listPurchaseOrders(shopId, {offset, limit})` through `po_list` (SQL-side line aggregates and a
  window total avoid PostgREST's 1,000-row clamp),
  `getPurchaseOrder`, `createPurchaseOrder` (validates lines, resolves supplier + snapshot
  `vendor_name`, defaults `expected_at` from lead time, generates `po_number`),
  `updateDraftPurchaseOrder`, `markOrdered`, `receiveLines`, `cancelPurchaseOrder`,
  `promoteAuditDraft(shopId, auditId)` (maps `params.po.lines[].sku` → `variant_dim` by SKU,
  shop-scoped; unknown SKUs 422 `sku_not_found`; sets `source='autopilot'`, `audit_id`; blocks
  double-promotion via partial unique index on `purchase_order(audit_id) where audit_id is not null`).
- `app/lib/po/suppliers.server.ts` — `listSuppliers`, `createSupplier`, `updateSupplier`,
  `setSupplierActive`. Duplicate name → 422 `supplier_name_taken`.
- Routes (all `requireDashboardSession`; writes also `requireSameOrigin`; `dashboardJson` +
  `jsonOk`/`jsonError` envelope, transfer-route style):
  - `dashboard.api.po._index.tsx` — GET list (`?status=`), POST `{intent:"create", ...}` and
    `{intent:"promote_draft", auditId}`.
  - `dashboard.api.po.$id.tsx` — GET detail, POST intents `update` / `mark_ordered` / `receive` /
    `cancel`.
  - `dashboard.api.po.suppliers.tsx` — GET list, POST intents `create` / `update` / `set_active`.
  - `dashboard.api.po.$id[.]pdf.tsx` — maps a real PO to the `PoDraft` shape and reuses
    `renderPoPdf`; `Content-Disposition: attachment`.
- Existing audit-snapshot PDF route stays (legacy drafts still downloadable).

## UI (single screen, `products-po`, keep-it-simple)

Rewrite `app/components/dashboard/screens/PurchaseOrders.tsx`:

- Header: `h1 Products` / sub `Purchase orders` (existing convention), primary button
  "New purchase order", secondary "Suppliers".
- PO table: PO number, supplier, destination, ETA (relative + absolute), status badge
  (draft/ordered/partial/received/cancelled), lines/units summary, total, updated. Row click opens a
  detail drawer (pattern: Inventory stock drawer) with lines (SKU, title, ordered, received,
  remaining, unit cost), notes, and the actions valid for its status: Edit (draft), Mark ordered
  (draft), Receive… (ordered/partial; per-line qty inputs prefilled with remaining + "Receive all"),
  Cancel (draft/ordered/partial; confirm), Download PDF (always).
- "New purchase order" modal (pattern: TransferModal): supplier select (or none), destination
  location select (active only), ETA date input (auto-filled from supplier lead time, editable),
  variant picker with qty + unit-cost per line (variant search like the transfer picker), notes.
  Creates in `draft`.
- Suppliers modal: list + inline create/edit (name, email, phone, lead time, notes, active toggle).
- "Autopilot drafts" section below the PO table: the existing `create_po_draft` audit rows
  (unchanged data source: shell `app.audit`), minus ones already promoted (promoted `audit_id`s come
  from the PO list payload); each row keeps Download PDF and gains "Convert to PO" — which promotes
  and opens the resulting draft PO.
- Empty states: no POs → point at "New purchase order" and the drafts section; keep honest
  error/loading states (skeleton, refetch-failure notice) like Transfers.

### Screen cache
New `SCREEN_CACHE_KEYS.po` seeding `{ pos, suppliers, promotedAuditIds }`; screen seeds from
`cachedScreenData`, write-through after fetches/mutations, and a `WARM_TARGETS` entry in
`app/lib/dashboard/prefetch.ts` (exact key + payload shape).

### Client module
`app/lib/dashboard/po-client.ts` (own module so parallel work never collides): `SupplierVM`,
`PoLineVM`, `PoListItemVM`, `PoDetailVM`, fetchers + mutation wrappers throwing `DashboardApiError`.

## Inventory screen tie-in

`inventory_balance.incoming` already flows into `VariantBalance.incoming`. No change needed for v1;
Available math is untouched by incoming.

## Validation & errors

Action-boundary validation for every write (422 `invalid_json` / `invalid_po` / `invalid_receive` /
named codes above); all Supabase errors surfaced (no swallowed catches); receive/cancel/ordered are
idempotent at the ledger layer via idempotency keys; double-submit prevented by status checks.

## Tests

- Unit tests (vitest) for `purchase-orders.server.ts` validation + DTO shaping + promote mapping
  (mock supabase client, same style as `app/lib/actions/__tests__/inventory-relocate.test.ts`).
- Route tests where the repo has precedent.
- SQL function behavior exercised live during browser verification (prod Supabase, demo shop) —
  matches how `inventory_receive_transfer` shipped.

## Migration rollout

The live base schema is `supabase/migrations/20260710200000_purchase_orders.sql` (tables + RLS +
functions + grants). Reliability corrections ship separately in
`supabase/migrations/20260710225348_purchase_order_reliability.sql`; the already-applied base
migration is never rewritten or reapplied. Check migration history before applying the follow-up.
