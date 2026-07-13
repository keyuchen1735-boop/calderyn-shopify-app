# Orders Core (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the order lifecycle spine — refund restock + reason, agentic-order reservation, fulfillment with tracking + shipping email, merchant cancel, notes/tags/archive, and a full order detail page — per the approved spec `docs/superpowers/specs/2026-07-09-orders-close-out-design.md` (Phase 1).

**Architecture:** Three sequential PR groups off `origin/main` in worktree `feat/orders-core`. Group A closes inventory loose ends (restock RPC, refund restock flag, agentic reserve). Group B builds the fulfillment/cancel backend (tables, state machine, executors, emails, detail read-model, API routes). Group C is the UI (order detail screen inside the Orders screen via `nav.param`, fulfill/cancel modals, list upgrades). All server writes go through the existing audited-executor conventions (`priorExecutionForKey` / `insertAuditWithIdempotency`), all state changes through `transitionOrder`.

**Tech Stack:** Remix (Vite) + React 18, TypeScript strict, Supabase Postgres (SQL migrations + PostgREST via `getSupabase()`), Stripe (existing refund executor), Resend (existing `sendEmail`), vitest with the in-memory Supabase Builder mock pattern, `cd-*` design system + Lucide via `CDIcon`.

## Global Constraints

- Baseline is **origin/main** (`844b3d1a` or later): reserve-at-checkout, commit-on-paid, `seedInitialStock`, `remainingRefundableCents` are ALREADY there. Do not re-implement them.
- **Never modify** `app/lib/order/checkout.server.ts`, `app/lib/payments/stripe.server.ts`, `app/lib/payments/connect.server.ts`, `app/lib/commerce/stripe-checkout.server.ts` — the in-flight `feat/checkout-payments-hardening` branch owns them right now.
- TypeScript strict; no `any` without written justification; prefer `unknown` + narrowing.
- Dashboard routes: `requireDashboardSession(request)` on every loader/action; `requireSameOrigin(request)` before any write; validated bodies; never trust request-body shapes.
- Every new table: shop-scoped, RLS `shop_scope` policy on `public.current_shop_id()`, `revoke all ... from anon, authenticated` (copy the `order_spine.sql` pattern).
- Migration filenames must have UNIQUE version prefixes (`20260709xxxxxx_*`) — duplicate prefixes caused prod drift before.
- UI: `cd-*` primitives only (`Card`, `Btn`, `Pill`, `Placeholder`, `Tooltip`, `TableSkeleton`); icons only via the `CDIcon` registry (`app/components/dashboard/icons.tsx`); `money(cents, currency)` from `../format`.
- No AI/provenance/prototype markers in any browser-visible source. No em dashes in user-facing copy.
- Money is integer cents everywhere.
- Emails: mirror `confirmation-email.server.ts` — best-effort, at-most-once, PII-free logs, NEVER throws.
- Commit messages: `orders/<area>: <what>` style, one logical change each, end with the Claude Code trailer.
- Gate before each PR: `npm run typecheck` → `npm run lint` → `npm run build`, plus `npx vitest run <touched tests>`.

## Worktree setup (fold into Task 1's first step)

```bash
git fetch origin main
git worktree add ../calderyn-orders-core -b feat/orders-core origin/main
cd ../calderyn-orders-core
npm install
# Do NOT run `prisma generate` while any vite:dev is running elsewhere (EPERM corrupts shared .prisma types).
```

Copy the spec + this plan into the worktree as its first commit:

```bash
git add docs/superpowers/specs/2026-07-09-orders-close-out-design.md docs/superpowers/plans/2026-07-09-orders-core-phase1.md
git commit -m "docs/specs: orders close-out design + phase-1 plan"
```

(The two files exist in the main workspace at `c:\Users\famou\Desktop\calderyn-shopify-app\docs\superpowers\...` — copy them in.)

---

# Group A — inventory loose ends (PR 1: `orders/refunds: restock + reason; commerce: agentic reserve`)

### Task 1: `inventory_restock` SQL function + engine wrapper

**Files:**
- Create: `supabase/migrations/20260709180000_inventory_restock_fn.sql`
- Modify: `app/lib/inventory/engine.server.ts` (append after `seedInitialStock`)
- Test: `app/lib/inventory/__tests__/restock.server.test.ts`

**Interfaces:**
- Consumes: `ensurePrimaryLocation(shopId)` and `projectLevelFact(shopId, variantId, locationId)` (both exist).
- Produces: `restockOrderLines(shopId: string, orderId: string, reason: string): Promise<{ restockedLines: number }>` — Task 2 calls this from the refund executor; Task 7 calls it from cancel.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260709180000_inventory_restock_fn.sql
-- Refund/cancel restock: put sold units back into on_hand as an atomic relative
-- increment (FOR UPDATE lock), journaled as a 'restock' ledger entry. Relative,
-- not absolute, so a restock racing a concurrent sale composes instead of
-- clobbering (same rule as inventory_mark_unavailable). Idempotency comes from
-- the caller's key: one ledger row per (order, variant) restock intent.

alter table public.inventory_ledger drop constraint if exists inventory_ledger_entry_type_check;
alter table public.inventory_ledger add constraint inventory_ledger_entry_type_check
  check (entry_type in ('receive','adjust','transfer_out','transfer_in','in_transit','received','reserve','release','sale','mark_unavailable','restock'));

create or replace function public.inventory_restock(
  p_shop_id uuid, p_variant_id uuid, p_location_id uuid, p_qty int, p_idempotency_key text, p_reason text
) returns void language plpgsql set search_path = '' as $$
begin
  if p_qty < 1 then raise exception 'invalid_qty' using errcode = 'P0001'; end if;
  -- Dedup on the caller's key: a replayed refund/cancel must not double-restock.
  if exists (select 1 from public.inventory_ledger
             where shop_id = p_shop_id and idempotency_key = p_idempotency_key) then
    return;
  end if;
  insert into public.inventory_balance (shop_id, variant_id, location_id, on_hand, version, updated_at)
    values (p_shop_id, p_variant_id, p_location_id, 0, 0, now())
    on conflict (variant_id, location_id) do nothing;
  perform 1 from public.inventory_balance
    where shop_id = p_shop_id and variant_id = p_variant_id and location_id = p_location_id
    for update;
  update public.inventory_balance set on_hand = on_hand + p_qty, version = version + 1, updated_at = now()
    where shop_id = p_shop_id and variant_id = p_variant_id and location_id = p_location_id;
  insert into public.inventory_ledger (shop_id, variant_id, location_id, entry_type, qty, idempotency_key, reason, source)
    values (p_shop_id, p_variant_id, p_location_id, 'restock', p_qty, p_idempotency_key, p_reason, 'merchant');
end $$;
```

- [ ] **Step 2: Write the failing test**

Follow the in-memory Builder mock pattern from `app/lib/order/checkout.server.test.ts` (vi.hoisted store + `vi.mock("~/lib/supabase.server", ...)`). The engine calls `rpc()` — extend the mock client with an `rpc` spy, plus a `from()` Builder for the `order_line`/`variant_dim`/`location_dim` reads:

```ts
// app/lib/inventory/__tests__/restock.server.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";

const store = vi.hoisted(() => {
  type Row = Record<string, any>;
  const db: Record<string, Row[]> = { order_line: [], variant_dim: [], location_dim: [], inventory_reservation: [] };
  const rpc = vi.fn(async () => ({ data: null, error: null }));
  class Builder {
    private filters: Array<[string, unknown]> = [];
    private inFilters: Array<[string, unknown[]]> = [];
    private ord: string | null = null;
    private lim = 0;
    constructor(private table: string) {}
    select(_c?: string) { return this; }
    insert(p: Row | Row[]) { const rows = Array.isArray(p) ? p : [p]; rows.forEach((r) => db[this.table].push({ id: `${this.table}-${db[this.table].length + 1}`, ...r })); return this; }
    eq(c: string, v: unknown) { this.filters.push([c, v]); return this; }
    in(c: string, v: unknown[]) { this.inFilters.push([c, v]); return this; }
    order(c: string, _o?: unknown) { this.ord = c; return this; }
    limit(n: number) { this.lim = n; return this; }
    single() { return this.then((r: any) => ({ data: (r.data as Row[])[0] ?? null, error: null })); }
    then(res: (v: { data: unknown; error: unknown }) => unknown, rej?: (e: unknown) => unknown) {
      let rows = db[this.table].filter((r) => this.filters.every(([c, v]) => r[c] === v) && this.inFilters.every(([c, vs]) => vs.includes(r[c])));
      if (this.lim) rows = rows.slice(0, this.lim);
      return Promise.resolve({ data: rows, error: null }).then(res, rej);
    }
  }
  return { db, rpc, client: { from: (t: string) => new Builder(t), rpc } };
});

vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => store.client }));
vi.mock("~/lib/inventory/project-level-fact.server", () => ({ projectLevelFact: vi.fn(async () => {}) }));

import { restockOrderLines } from "../engine.server";

describe("restockOrderLines", () => {
  beforeEach(() => {
    for (const k of Object.keys(store.db)) store.db[k].length = 0;
    store.rpc.mockClear();
    store.db.location_dim.push({ id: "loc-1", shop_id: "shop-1", priority: 0, created_at: "2026-01-01" });
    store.db.order_line.push(
      { id: "ol-1", shop_id: "shop-1", order_id: "o-1", variant_id: "v-tracked", quantity: 2 },
      { id: "ol-2", shop_id: "shop-1", order_id: "o-1", variant_id: "v-untracked", quantity: 1 },
    );
    store.db.variant_dim.push(
      { id: "v-tracked", shop_id: "shop-1", inventory_tracked: true },
      { id: "v-untracked", shop_id: "shop-1", inventory_tracked: false },
    );
  });

  it("restocks only tracked lines, keyed idempotently per (order, variant)", async () => {
    const res = await restockOrderLines("shop-1", "o-1", "refund");
    expect(res.restockedLines).toBe(1);
    expect(store.rpc).toHaveBeenCalledTimes(1);
    expect(store.rpc).toHaveBeenCalledWith("inventory_restock", {
      p_shop_id: "shop-1", p_variant_id: "v-tracked", p_location_id: "loc-1",
      p_qty: 2, p_idempotency_key: "restock:o-1:v-tracked", p_reason: "refund",
    });
  });

  it("returns 0 and calls nothing when no line is tracked", async () => {
    store.db.variant_dim.find((v) => v.id === "v-tracked")!.inventory_tracked = false;
    const res = await restockOrderLines("shop-1", "o-1", "refund");
    expect(res.restockedLines).toBe(0);
    expect(store.rpc).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run app/lib/inventory/__tests__/restock.server.test.ts`
Expected: FAIL — `restockOrderLines` is not exported from `../engine.server`.

- [ ] **Step 4: Implement in `engine.server.ts`** (append after `seedInitialStock`)

```ts
// Refund/cancel restock: put a whole order's sold units back into on_hand at the
// shop's primary location. Amount-based Phase-1 refunds have no line selection, so
// this is all-lines-or-nothing (per-line restock arrives with returns). Only
// tracked variants restock (untracked lines never held ledger stock). Idempotent:
// the ledger key restock:<order>:<variant> makes a replayed refund/cancel a no-op.
export async function restockOrderLines(
  shopId: string, orderId: string, reason: string,
): Promise<{ restockedLines: number }> {
  const sb = getSupabase();
  const { data: lines, error: lErr } = await sb
    .from("order_line")
    .select("variant_id, quantity")
    .eq("shop_id", shopId)
    .eq("order_id", orderId);
  if (lErr) throw lErr;
  const byVariant = new Map<string, number>();
  for (const l of (lines ?? []) as Array<Record<string, unknown>>) {
    const v = String(l.variant_id);
    byVariant.set(v, (byVariant.get(v) ?? 0) + Number(l.quantity ?? 0));
  }
  if (byVariant.size === 0) return { restockedLines: 0 };

  const { data: variants, error: vErr } = await sb
    .from("variant_dim")
    .select("id, inventory_tracked")
    .eq("shop_id", shopId)
    .in("id", [...byVariant.keys()]);
  if (vErr) throw vErr;
  const tracked = new Set(
    ((variants ?? []) as Array<Record<string, unknown>>)
      .filter((r) => r.inventory_tracked === true)
      .map((r) => String(r.id)),
  );
  if (tracked.size === 0) return { restockedLines: 0 };

  const locationId = await ensurePrimaryLocation(shopId);
  let restockedLines = 0;
  for (const [variantId, qty] of byVariant) {
    if (!tracked.has(variantId) || qty <= 0) continue;
    const { error } = await sb.rpc("inventory_restock", {
      p_shop_id: shopId, p_variant_id: variantId, p_location_id: locationId,
      p_qty: qty, p_idempotency_key: `restock:${orderId}:${variantId}`, p_reason: reason,
    });
    if (error) throw error;
    await projectLevelFact(shopId, variantId, locationId);
    restockedLines += 1;
  }
  return { restockedLines };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run app/lib/inventory/__tests__/restock.server.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Apply the migration to prod via the supabase MCP** (`apply_migration`, name `inventory_restock_fn`), then verify the function exists (`execute_sql`: `select proname from pg_proc where proname = 'inventory_restock';` → 1 row).

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260709180000_inventory_restock_fn.sql app/lib/inventory/engine.server.ts app/lib/inventory/__tests__/restock.server.test.ts
git commit -m "inventory: atomic inventory_restock fn + restockOrderLines wrapper"
```

### Task 2: refund executor gains `restock` (full refunds only)

**Files:**
- Modify: `app/lib/actions/refund.server.ts`
- Modify: `app/routes/dashboard.api.orders.$id.refund.tsx`
- Test: extend `app/lib/actions/__tests__/refund.server.test.ts` if it exists (check with `ls app/lib/actions/__tests__/`); otherwise add route-level validation to the existing route test file under `app/routes/__tests__/` matching its conventions. If neither exists, create `app/lib/actions/__tests__/refund-restock.server.test.ts` with the Builder mock pattern (mock `~/lib/supabase.server`, `../payments/refund.server` createRefund seam, and `~/lib/inventory/engine.server` restockOrderLines).

**Interfaces:**
- Consumes: `restockOrderLines(shopId, orderId, reason)` from Task 1.
- Produces: `RefundActionInput` gains `restock?: boolean`; `RefundActionResult` gains `restockedLines: number` (0 when skipped). Route body accepts `restock?: boolean`. Task 10's RefundModal sends it.

- [ ] **Step 1: Write the failing test** — executor invoked with `restock: true` on a refund that fully refunds the order calls `restockOrderLines` once with `(shopId, orderId, "refund")`; with a partial amount it does NOT call it and returns `restockedLines: 0`. Mock the Stripe seam via the existing injectable `RefundDeps.createRefund`.

```ts
// Core assertions (adapt store seeding to the executor's reads: orders, payment_intent,
// transaction_ledger, action_idempotency, action_audit, order_state_transition):
const restock = vi.hoisted(() => ({ restockOrderLines: vi.fn(async () => ({ restockedLines: 2 })) }));
vi.mock("~/lib/inventory/engine.server", () => restock);
// full refund + restock:true -> called once
expect(restock.restockOrderLines).toHaveBeenCalledWith("shop-1", "o-1", "refund");
// partial refund + restock:true -> not called, result.restockedLines === 0
```

- [ ] **Step 2: Run it** — Expected: FAIL (`restock` not accepted / `restockedLines` undefined).

- [ ] **Step 3: Implement.** In `refund.server.ts`:
  1. Add to `RefundActionInput`: `/** Restock all lines at the primary location — honored only when this refund makes the order fully refunded. */ restock?: boolean;`
  2. Add to `RefundActionResult`: `restockedLines: number;`
  3. Import `restockOrderLines` from `../inventory/engine.server`.
  4. After the state transition / `resolvedState` is known and before the audit insert (next to the existing financial_status stamp), add:

```ts
  // 8c. Optional restock — FULL refunds only (amount-based partials can't say which
  // lines came back; per-line restock ships with returns). Best-effort like 8b: the
  // money already moved, so a restock failure logs loudly and lands in the audit
  // params rather than failing the refund.
  let restockedLines = 0;
  if (input.restock === true && resolvedState === "refunded") {
    try {
      const r = await restockOrderLines(shopId, input.orderId, "refund");
      restockedLines = r.restockedLines;
      params.restocked_lines = restockedLines;
    } catch (err) {
      params.restock_error = err instanceof Error ? err.message : String(err);
      console.error(
        `[refund] order ${input.orderId} refund ${refund.refundId}: restock failed — reconcile inventory manually`,
        err,
      );
    }
  } else if (input.restock === true) {
    params.restock_skipped = "partial_refund";
  }
```

  5. Include `restockedLines` in the returned result object (and `restockedLines: 0` on the replay path).

  In the route (`dashboard.api.orders.$id.refund.tsx`), read the module first, then extend the validated body: `restock` must be `undefined` or `boolean` (422 `invalid_restock` otherwise) and pass it through to `executeRefundAction`. Include `restocked_lines` in the JSON response.

- [ ] **Step 4: Run tests** — `npx vitest run app/lib/actions` Expected: PASS, plus previously-existing refund tests still green.

- [ ] **Step 5: Commit**

```bash
git add app/lib/actions/refund.server.ts app/routes/dashboard.api.orders.\$id.refund.tsx app/lib/actions/__tests__/
git commit -m "orders/refund: optional full-refund restock through inventory_restock"
```

### Task 3: RefundModal — reason field + restock checkbox

**Files:**
- Modify: `app/components/dashboard/screens/RefundModal.tsx` (origin/main version — full/partial select, `remainingRefundableCents`-driven)
- Modify: `app/lib/dashboard/orders-client.ts` (`refundOrder` args: add `restock?: boolean`, send `restock` in the body; add `restockedLines: number` to `RefundResult` mapped from `restocked_lines`)

**Interfaces:**
- Consumes: route contract from Task 2.
- Produces: the modal UI. No new exports.

- [ ] **Step 1: Implement.** In `RefundModal.tsx` add state `const [reason, setReason] = useState("");` and `const [restock, setRestock] = useState(false);`. Below the partial-amount field add:

```tsx
            <label className="cd-field">
              <span>Reason (optional)</span>
              <input
                className="cd-input"
                type="text"
                maxLength={200}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Damaged in transit"
              />
            </label>
            {full && (
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} />
                <span className="cd-caption">Restock all items at your primary location</span>
              </label>
            )}
```

Pass both through `refundOrder(order.id, { amountCents: full ? undefined : partialCents, idempotencyKey, reason: reason.trim() || undefined, restock: full ? restock : undefined })`. On success, extend the toast when items restocked: `` `Refunded ${money(...)} — order is now ${...}.${res.restockedLines > 0 ? " Items restocked." : ""}` ``.

- [ ] **Step 2: Verify** — `npm run typecheck` exit 0; `npx vitest run app/components app/lib/dashboard` green.

- [ ] **Step 3: Commit**

```bash
git add app/components/dashboard/screens/RefundModal.tsx app/lib/dashboard/orders-client.ts
git commit -m "dashboard/RefundModal: reason field + full-refund restock checkbox"
```

### Task 4: agentic orders reserve stock

**Files:**
- Modify: `app/lib/commerce/order.server.ts`
- Test: `app/lib/commerce/__tests__/place-order-reserve.test.ts`

**Interfaces:**
- Consumes: `reserveStock`, `releaseReservation` from `~/lib/inventory/engine.server`; `transitionOrder` from `~/lib/order/order.server`.
- Produces: `placeAgenticOrder` throws a new exported `class OutOfStockError extends Error { code = "OUT_OF_STOCK"; constructor(public variantIds: string[]) { super(...) } }` (mirror the one `checkout.server.ts` exports on origin/main — CHECK first whether `checkout.server.ts` already exports `OutOfStockError`; if it does, import THAT instead of defining a second one).

- [ ] **Step 1: Write the failing test.** Builder-mock `orders`, `order_line`, `variant_dim`, `buyer_dim` etc. (copy the harness shape from `checkout.server.test.ts`), mock `~/lib/commerce/quote-store.server` `getQuote` to return a locked quote with two lines (one tracked variant, one untracked), and mock `~/lib/inventory/engine.server`:
  - happy path: `reserveStock` called once (tracked line only) with `checkoutRef` = the created order id;
  - stockout path: `reserveStock` returns `{ ok: false, reason: "insufficient_stock" }` → `releaseReservation` called with the order id, the order transitions to `cancelled`, and the call rejects with `OutOfStockError`.

- [ ] **Step 2: Run it** — Expected: FAIL (no reservation happens today).

- [ ] **Step 3: Implement.** In `placeAgenticOrder`, after the `order_line` insert and before `return`, add the same tracked-lines reserve block `createCheckout` uses (quoted in full below so this task is self-contained; adapt `priced.lines` → `quote.lines`):

```ts
  // Oversell protection (same contract as createCheckout): reserve TRACKED lines
  // keyed on the order id before handing the order to the payment surface. The
  // webhook commits by this key on payment; the reaper releases abandoned holds.
  const trackedRes = await sb
    .from("variant_dim")
    .select("id, inventory_tracked")
    .eq("shop_id", shopId)
    .in("id", quote.lines.map((l) => l.variantId));
  if (trackedRes.error) throw trackedRes.error;
  const tracked = new Set(
    ((trackedRes.data ?? []) as Record<string, unknown>[])
      .filter((r) => r.inventory_tracked === true)
      .map((r) => String(r.id)),
  );
  if (tracked.size > 0) {
    const soldOut: string[] = [];
    for (const line of quote.lines) {
      if (!tracked.has(line.variantId)) continue;
      const res = await reserveStock(shopId, line.variantId, line.quantity, orderId, null);
      if (!res.ok) soldOut.push(line.variantId);
    }
    if (soldOut.length > 0) {
      await releaseReservation(shopId, orderId);
      await transitionOrder(shopId, orderId, "cancelled", "agentic:out_of_stock");
      throw new OutOfStockError(soldOut);
    }
  }
```

- [ ] **Step 4: Run tests** — `npx vitest run app/lib/commerce` Expected: PASS.

- [ ] **Step 5: Gate + PR 1.** Run `npm run typecheck && npm run lint && npm run build`, `npx vitest run app/lib`, `/code-review` on the working tree; fix blockers. Commit, push, open PR titled `orders: refund restock + reason; agentic orders reserve stock`.

```bash
git add app/lib/commerce/order.server.ts app/lib/commerce/__tests__/place-order-reserve.test.ts
git commit -m "commerce/placeAgenticOrder: reserve tracked lines, cancel on stockout"
git push -u origin feat/orders-core
gh pr create --title "orders: refund restock + reason + agentic reserve (phase 1, PR 1/3)" --body "..."
```

---

# Group B — fulfillment / cancel spine (PR 2: keep working on the same `feat/orders-core` branch; open PR 2 after PR 1 merges and the branch is rebased on main)

### Task 5: fulfillment-spine migration

**Files:**
- Create: `supabase/migrations/20260709190000_order_fulfillment_spine.sql`

**Interfaces:**
- Produces tables `fulfillment`, `fulfillment_line`, `order_note`, `order_tag`; columns `orders.archived_at`, `orders.cancelled_at`, `orders.cancel_reason`; state-check constraints gain `partially_fulfilled`; `action_kind` enum gains `fulfill_order` + `cancel_order`.

- [ ] **Step 1: Write the migration** (RLS pattern copied from `order_spine.sql`; enum pattern from `20260703030000_action_kind_issue_refund.sql` — read that file first and mirror its `alter type ... add value if not exists` form):

```sql
-- supabase/migrations/20260709190000_order_fulfillment_spine.sql
-- Fulfillment + merchant order-management spine (orders close-out phase 1):
-- fulfillments with tracking, staff notes, tags, archive/cancel stamps, and the
-- partially_fulfilled state. Shop-scoped + RLS like every order-spine table.

-- 1) State vocabulary: partially_fulfilled between paid and fulfilled.
alter table public.orders drop constraint if exists orders_state_check;
alter table public.orders add constraint orders_state_check
  check (state in ('cart','checkout_pending','paid','partially_fulfilled','fulfilled','cancelled','refunded','partially_refunded'));
alter table public.order_state_transition drop constraint if exists order_state_transition_from_state_check;
alter table public.order_state_transition drop constraint if exists order_state_transition_to_state_check;
-- NOTE: inspect \d order_state_transition constraint names on prod first (execute_sql on
-- information_schema.check_constraints) and drop/recreate the actual from/to state checks
-- with the same 8-value list. If the transition table has no state checks, skip this pair.

-- 2) Merchant lifecycle stamps on orders.
alter table public.orders add column if not exists archived_at timestamptz;
alter table public.orders add column if not exists cancelled_at timestamptz;
alter table public.orders add column if not exists cancel_reason text;

-- 3) fulfillment: one shipment record (whole or partial) with optional tracking.
create table if not exists public.fulfillment (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  status text not null default 'shipped' check (status in ('shipped')),
  tracking_number text,
  carrier text,
  tracking_url text,
  notified_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists fulfillment_order_idx on public.fulfillment (shop_id, order_id);
alter table public.fulfillment enable row level security;
create policy fulfillment_shop_scope on public.fulfillment
  for all using (shop_id = public.current_shop_id()) with check (shop_id = public.current_shop_id());
revoke all on table public.fulfillment from anon, authenticated;

-- 4) fulfillment_line: which order lines (and how many units) each fulfillment covers.
create table if not exists public.fulfillment_line (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  fulfillment_id uuid not null references public.fulfillment(id) on delete cascade,
  order_line_id uuid not null references public.order_line(id) on delete cascade,
  quantity int not null check (quantity > 0)
);
create index if not exists fulfillment_line_f_idx on public.fulfillment_line (shop_id, fulfillment_id);
create index if not exists fulfillment_line_ol_idx on public.fulfillment_line (shop_id, order_line_id);
alter table public.fulfillment_line enable row level security;
create policy fulfillment_line_shop_scope on public.fulfillment_line
  for all using (shop_id = public.current_shop_id()) with check (shop_id = public.current_shop_id());
revoke all on table public.fulfillment_line from anon, authenticated;

-- 5) order_note: append-only staff notes shown in the order timeline.
create table if not exists public.order_note (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  author_email text not null,
  body text not null check (length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists order_note_order_idx on public.order_note (shop_id, order_id);
alter table public.order_note enable row level security;
create policy order_note_shop_scope on public.order_note
  for all using (shop_id = public.current_shop_id()) with check (shop_id = public.current_shop_id());
revoke all on table public.order_note from anon, authenticated;

-- 6) order_tag: flat tags; filtering ships with the phase-2 list power tools.
create table if not exists public.order_tag (
  shop_id uuid not null references public.shops(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  tag text not null check (length(tag) between 1 and 60),
  created_at timestamptz not null default now(),
  primary key (shop_id, order_id, tag)
);
alter table public.order_tag enable row level security;
create policy order_tag_shop_scope on public.order_tag
  for all using (shop_id = public.current_shop_id()) with check (shop_id = public.current_shop_id());
revoke all on table public.order_tag from anon, authenticated;

-- 7) Audit vocabulary for the new merchant actions.
alter type public.action_kind add value if not exists 'fulfill_order';
alter type public.action_kind add value if not exists 'cancel_order';
```

- [ ] **Step 2: Resolve the NOTE.** Query prod (`execute_sql`): `select constraint_name, check_clause from information_schema.check_constraints where constraint_schema='public' and check_clause like '%checkout_pending%';` — replace the NOTE block with drops/recreates of the real transition-table constraint names (8-value list), or delete the pair if none exist. The committed migration must contain no NOTE comments.

- [ ] **Step 3: Apply to prod** via supabase MCP `apply_migration` (name `order_fulfillment_spine`); verify: `select count(*) from information_schema.tables where table_name in ('fulfillment','fulfillment_line','order_note','order_tag');` → 4.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260709190000_order_fulfillment_spine.sql
git commit -m "db/orders: fulfillment + notes + tags tables, partially_fulfilled state, cancel/archive stamps"
```

### Task 6: state machine — `partially_fulfilled` + cancel edges

**Files:**
- Modify: `app/lib/order/state.ts`
- Modify: `app/lib/actions/refund.server.ts` (REFUNDABLE_STATES gains `partially_fulfilled`)
- Modify: `app/lib/actions/execute.server.ts` (`ExecutableKind` union gains `"fulfill_order" | "cancel_order"` — read lines 19-26 first and extend the union in place)
- Test: `app/lib/order/state.test.ts` (create if absent; if a state test exists, extend it)

**Interfaces:**
- Produces: `ORDER_STATES` includes `"partially_fulfilled"`; `LEGAL_TRANSITIONS` exactly:
  - `checkout_pending: ["paid", "cancelled"]` (unchanged)
  - `paid: ["partially_fulfilled", "fulfilled", "cancelled", "refunded", "partially_refunded"]`
  - `partially_fulfilled: ["fulfilled", "cancelled", "refunded", "partially_refunded"]`
  - `fulfilled: ["refunded", "partially_refunded"]` (unchanged — a fully fulfilled order is refunded, not cancelled)
  - everything else unchanged; `cancelled`/`refunded` stay terminal.

- [ ] **Step 1: Write failing tests** — table-driven over the new edges (legal: paid→partially_fulfilled, partially_fulfilled→fulfilled, paid→cancelled, partially_fulfilled→cancelled; illegal: fulfilled→cancelled, partially_fulfilled→paid, cancelled→anything, identity partially_fulfilled→partially_fulfilled).

```ts
// app/lib/order/state.test.ts
import { describe, it, expect } from "vitest";
import { isLegalTransition, assertLegalTransition, ORDER_STATES } from "./state";

describe("order state machine — fulfillment + cancel edges", () => {
  it("knows partially_fulfilled", () => {
    expect(ORDER_STATES).toContain("partially_fulfilled");
  });
  it.each([
    ["paid", "partially_fulfilled", true],
    ["paid", "fulfilled", true],
    ["paid", "cancelled", true],
    ["partially_fulfilled", "fulfilled", true],
    ["partially_fulfilled", "cancelled", true],
    ["partially_fulfilled", "partially_refunded", true],
    ["fulfilled", "cancelled", false],
    ["partially_fulfilled", "paid", false],
    ["partially_fulfilled", "partially_fulfilled", false],
    ["cancelled", "paid", false],
  ] as const)("%s -> %s legal=%s", (from, to, legal) => {
    expect(isLegalTransition(from, to)).toBe(legal);
  });
  it("throws visibly on an illegal edge", () => {
    expect(() => assertLegalTransition("fulfilled", "cancelled")).toThrow(/illegal order transition/);
  });
});
```

- [ ] **Step 2: Run** — Expected: FAIL (unknown state).
- [ ] **Step 3: Implement** the `ORDER_STATES` + `LEGAL_TRANSITIONS` changes exactly as the Interfaces block; update the file's header comment to note the new state mirrors the migration from Task 5. Add `"partially_fulfilled"` to `REFUNDABLE_STATES` in `refund.server.ts` and to its error message; extend `ExecutableKind`.
- [ ] **Step 4: Run** — `npx vitest run app/lib/order app/lib/actions` Expected: PASS including existing suites.
- [ ] **Step 5: Commit** — `git commit -m "orders/state: partially_fulfilled + merchant-cancel edges"`

### Task 7: fulfill + cancel executors

**Files:**
- Create: `app/lib/order/fulfill.server.ts`
- Create: `app/lib/order/cancel.server.ts`
- Test: `app/lib/order/fulfill.server.test.ts`, `app/lib/order/cancel.server.test.ts`

**Interfaces:**
- Consumes: `transitionOrder`, `priorExecutionForKey`, `insertAuditWithIdempotency`, `restockOrderLines`, `releaseReservation`, `executeRefundAction`, `sendShippingConfirmation`/`sendCancellationNotice` (Task 8 — stub the import with `vi.mock` in tests; write Task 8 before running these tests, or implement both tasks then test).
- Produces:

```ts
// fulfill.server.ts
export interface FulfillLineInput { orderLineId: string; quantity: number }
export interface FulfillActionInput {
  orderId: string;
  lines?: FulfillLineInput[];            // omitted = everything unfulfilled
  trackingNumber?: string | null;
  carrier?: string | null;
  notify: boolean;
  idempotencyKey: string;
  actor?: string;
}
export interface FulfillActionResult {
  auditId: string; fulfillmentId: string | null; orderState: OrderState;
  fulfilledUnits: number; notified: boolean; replayed: boolean;
}
export async function executeFulfillAction(shopId: string, input: FulfillActionInput, sb = getSupabase()): Promise<FulfillActionResult>

// cancel.server.ts
export interface CancelActionInput {
  orderId: string; reason?: string | null;
  refund: boolean; restock: boolean;
  idempotencyKey: string; actor?: string;
}
export interface CancelActionResult {
  auditId: string; orderState: OrderState; refunded: boolean;
  restockedLines: number; replayed: boolean;
}
export async function executeCancelAction(shopId: string, input: CancelActionInput, sb = getSupabase()): Promise<CancelActionResult>
```

**executeFulfillAction flow (implement exactly):**
1. `priorExecutionForKey` → replay short-circuit (`replayed: true`, `fulfillmentId: null`).
2. Load order (`id, state, buyer_id`) shop-scoped; 404 `CalderynError order_not_found`; 409 `order_not_fulfillable` unless state is `paid` or `partially_fulfilled`.
3. Load `order_line (id, quantity)` + existing `fulfillment` ids for the order + their `fulfillment_line (order_line_id, quantity)`; compute `remaining[lineId] = quantity − Σ fulfilled`.
4. Resolve requested lines: `input.lines` if present (409 `line_not_on_order` for a foreign id; 422 `over_fulfil` when `quantity > remaining`; 422 `nothing_to_fulfil` when all zero), else every line with `remaining > 0` at its full remaining.
5. Insert `fulfillment` row (status `shipped`, tracking fields, `tracking_url` = `input.trackingNumber ? null : null` — leave `tracking_url` null in phase 1 unless the caller supplies one later; do NOT synthesize carrier URLs).
6. Insert `fulfillment_line` rows.
7. Coverage: if every line's remaining hits 0 → target `fulfilled`, else `partially_fulfilled`. Skip `transitionOrder` when target === current state (identity moves are illegal — the second partial fulfillment of a `partially_fulfilled` order records rows only).
8. `notify && buyer` → `sendShippingConfirmation(shopId, orderId, { trackingNumber, carrier })`; when `.sent`, stamp `fulfillment.notified_at = now()`.
9. `insertAuditWithIdempotency(shopId, input.idempotencyKey, { alert_id: null, action_kind: "fulfill_order", params: {orderId, lines, trackingNumber, carrier, notify}, outcome: "succeeded", pre_state: {state: <from>}, post_state: {state: <to>, fulfillmentId}, last_error: null, actor_user_id: input.actor ?? "merchant", write_target: "owned_sot" }, sb)`.

Note on concurrency: the validate-then-insert sequence is non-transactional PostgREST, the same documented "ponytail" pattern as `transitionOrder` — two simultaneous partial fulfillments can race past the remaining-quantity check. The idempotency key dedups retries, the state CAS guards the transition, and the detail view surfaces any over-coverage; folding the check into a security-definer RPC is the same GA upgrade the rest of the spine already defers. State this in the module header comment.

**executeCancelAction flow (implement exactly):**
1. Replay short-circuit via `priorExecutionForKey`.
2. Load order (`id, state, cancelled_at`); 404; 409 `already_cancelled` when `cancelled_at` set or state `cancelled`; 409 `order_not_cancellable` unless state ∈ {`checkout_pending`, `paid`, `partially_fulfilled`}.
3. `checkout_pending`: `releaseReservation(shopId, orderId)` then `transitionOrder(..., "cancelled", input.reason ?? "merchant:cancel")`; refund flag is ignored (nothing captured) — record `params.refund_skipped = "not_captured"` when `input.refund`.
4. `paid`/`partially_fulfilled` + `input.refund`: `executeRefundAction(shopId, { orderId, idempotencyKey: input.idempotencyKey + ":refund", actor: input.actor, reason: input.reason ?? "order cancelled", restock: input.restock })` (full refund; its own restock handles stock) — state becomes `refunded` inside it. Do NOT also transition to `cancelled` (illegal from `refunded`).
5. `paid`/`partially_fulfilled` without refund: `transitionOrder(..., "cancelled", ...)`; if `input.restock`, `restockOrderLines(shopId, orderId, "cancel")` (committed stock returns to shelf).
6. Stamp `orders.cancelled_at = now()`, `cancel_reason = input.reason ?? null` (shop-scoped update).
7. `sendCancellationNotice(shopId, orderId, { refunded })` best-effort.
8. Audit row (`action_kind: "cancel_order"`, params carry reason/refund/restock/restockedLines).

- [ ] **Step 1: Write both executors' failing tests** with the Builder mock + `vi.mock` for engine/refund/email modules. Cover, minimum: fulfill default-all-lines full coverage → state `fulfilled`; explicit partial → `partially_fulfilled` + second partial on same order records rows without a transition; over-fulfil 422; replay returns `replayed: true` without inserts. Cancel: checkout_pending releases + cancels; paid+refund delegates to `executeRefundAction` with `restock` passed through and does NOT call `transitionOrder` to cancelled; paid without refund transitions + restocks when asked; already-cancelled 409.
- [ ] **Step 2: Run** — Expected: FAIL (modules don't exist).
- [ ] **Step 3: Implement both modules** per the flows above (each file starts with a 3-6 line header comment stating contract + failure mode, matching repo style; import `CalderynError` from `../calderyn.server` for coded errors).
- [ ] **Step 4: Run** — `npx vitest run app/lib/order` Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "orders: fulfill + cancel executors (audited, idempotent)"`

### Task 8: transactional emails — shipping / cancellation (+ refund notice wiring)

**Files:**
- Create: `app/lib/order/notify-email.server.ts`
- Modify: `app/lib/actions/refund.server.ts` (send refund notice after success, best-effort)
- Test: `app/lib/order/notify-email.server.test.ts`

**Interfaces:**
- Consumes: `sendEmail` from `~/lib/email/send.server`; `formatOrderRef`; buyer lookup identical to `confirmation-email.server.ts`.
- Produces:

```ts
export interface OrderEmailResult { sent: boolean; id?: string; error?: string }
export async function sendShippingConfirmation(shopId: string, orderId: string, opts: { trackingNumber?: string | null; carrier?: string | null }): Promise<OrderEmailResult>
export async function sendRefundNotice(shopId: string, orderId: string, opts: { amountCents: number }): Promise<OrderEmailResult>
export async function sendCancellationNotice(shopId: string, orderId: string, opts: { refunded: boolean }): Promise<OrderEmailResult>
```

- [ ] **Step 1: Write failing tests** — mock `~/lib/email/send.server` and the supabase client; assert: (a) shipping email subject `Order #XXXXXXXX is on the way` and body containing the tracking number when provided; (b) no buyer email → `{ sent: false }` without calling `sendEmail`; (c) `sendEmail` rejection is swallowed into `{ sent: false, error }` (never throws).
- [ ] **Step 2: Run** — FAIL (module missing).
- [ ] **Step 3: Implement** — copy `confirmation-email.server.ts`'s structure (config guards on `RESEND_API_KEY` + `ORDER_CONFIRM_FROM || PILOT_FROM || DIGEST_FROM`, shop-scoped order + buyer reads, PII-free logs, top-level try/catch returning a result) into ONE module with a private `loadOrderAndBuyer(shopId, orderId)` helper and the three public senders. Copy bodies:
  - shipping: "Good news! Your order {ref} has shipped." + `Tracking: {carrier ? carrier + " " : ""}{trackingNumber}` line when tracking present.
  - refund: "We've issued a refund of {money(amountCents, currency)} for order {ref}. It should appear on your statement within 5-10 business days."
  - cancellation: "Your order {ref} has been cancelled." + (refunded ? " A full refund has been issued to your original payment method." : "")
  In `refund.server.ts`, after the audit insert on the success path: `await sendRefundNotice(shopId, input.orderId, { amountCents: refund.amountCents }).catch(() => {});` — wrap consistent with its never-throws contract (the function already never throws; call it without catch but do not gate the return on it).
- [ ] **Step 4: Run** — `npx vitest run app/lib/order app/lib/actions` PASS.
- [ ] **Step 5: Commit** — `git commit -m "orders/email: shipping, refund, cancellation notices (best-effort, at-most-once)"`

### Task 9: order-detail read model

**Files:**
- Create: `app/lib/order/detail-types.ts` (plain types, browser-safe)
- Create: `app/lib/order/detail.server.ts`
- Test: `app/lib/order/detail.server.test.ts`

**Interfaces:**
- Produces (exact contract Tasks 10-12 build on):

```ts
// detail-types.ts
export interface OrderDetailLine {
  id: string; title: string; sku: string | null;
  quantity: number; unitPriceCents: number; fulfilledQuantity: number;
}
export interface OrderDetailFulfillment {
  id: string; createdAt: string; trackingNumber: string | null; carrier: string | null;
  notifiedAt: string | null; units: number;
}
export interface OrderTimelineEvent {
  kind: "transition" | "note" | "refund" | "fulfillment";
  at: string; title: string; detail: string | null; author: string | null;
}
export interface OrderDetail {
  source: "calderyn" | "shopify";
  id: string; ref: string; createdAt: string;
  state: string; financialStatus: string;
  archivedAt: string | null; cancelledAt: string | null; cancelReason: string | null;
  channel: string | null; attribution: string | null;
  currency: string;
  subtotalCents: number; shippingCents: number; taxCents: number;
  discountCents: number; totalCents: number;
  refundedCents: number; remainingRefundableCents: number;
  buyer: { id: string; email: string } | null;
  shippingAddress: { name: string | null; line1: string; line2: string | null; city: string | null; region: string | null; postal: string | null; country: string } | null;
  lines: OrderDetailLine[];
  fulfillments: OrderDetailFulfillment[];
  tags: string[];
  timeline: OrderTimelineEvent[];
  readOnly: boolean;   // true for imported (Shopify-paid) orders
}

// detail.server.ts
export async function loadOrderDetail(shopId: string, sourceId: string): Promise<OrderDetail | null>
// sourceId: "<uuid>" or "calderyn:<uuid>" -> native; "shopify:<uuid>" -> imported (read-only)
```

**Native branch reads (all shop-scoped, in parallel where independent):** `orders` row (all money/lifecycle cols + `buyer_id`, `channel`, `attribution`); `order_line` (id, variant_id, quantity, unit_price_cents, title_snapshot) with sku via a second `variant_dim` read (`id, sku`); `fulfillment` + `fulfillment_line` (sum units per line → `fulfilledQuantity`); `buyer_dim` (email_normalized); default-shipping `buyer_address` (`.eq("buyer_id", ...).eq("kind","shipping").order("is_default", {ascending:false}).limit(1)` — read `identity.server.ts` for exact column names before coding); `order_tag`; `order_note`; `order_state_transition`; `action_audit` refunds (`.eq("action_kind","issue_refund").eq("params->>orderId", orderId)`, select `created_at, params, outcome` — verify the audit table's timestamp column name in `execute.server.ts` before coding); `transaction_ledger` totals (reuse the summing shape from `list.server.ts` `remainingRefundableByOrder`). `discountCents` is 0 for native (no column exists).

**Timeline assembly:** map transitions → `{kind:"transition", title: "Checkout started" | "Paid" | "Fulfilled" | ...}` (humanize `to_state`, `detail: reason`), notes → `{kind:"note", title: "Note", detail: body, author: author_email}`, refund audits (outcome succeeded) → `{kind:"refund", title: "Refund issued", detail: money-from-params}` , fulfillments → `{kind:"fulfillment", title: "Items fulfilled" + (tracking ? ` · ${tracking}` : ""), detail: notifiedAt ? "Customer notified" : null}`. Sort descending by `at`.

**Imported branch:** `imported_order` (order_number, financial_status, currency, total/subtotal/shipping/tax/discount cents, processed_at, buyer_id) + `imported_order_line` with `sku_dim(sku, title)` embed + `imported_refund` (sum → refundedCents; each row also becomes a `refund` timeline event). `state` = financial_status; `fulfillments`/`tags`/`notes` empty; `readOnly: true`; `remainingRefundableCents: 0`.

- [ ] **Step 1: Write failing tests** — native order with 2 lines, one partial fulfillment, a note, and a refund audit → assert `fulfilledQuantity` math, timeline ordering (newest first), `remainingRefundableCents` from ledger rows; imported id (`shopify:` prefix) → `readOnly: true`, lines titled from `sku_dim`; unknown id → null.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** per the contract; parse the `sourceId` prefix first; return null on no row (route 404s).
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `git commit -m "orders/detail: unified native+imported order detail read model"`

### Task 10: API routes — detail, fulfill, cancel, notes, tags, archive

**Files:**
- Create: `app/routes/dashboard.api.orders.$id.tsx` (GET detail)
- Create: `app/routes/dashboard.api.orders.$id.fulfill.tsx`
- Create: `app/routes/dashboard.api.orders.$id.cancel.tsx`
- Create: `app/routes/dashboard.api.orders.$id.notes.tsx`
- Create: `app/routes/dashboard.api.orders.$id.tags.tsx`
- Create: `app/routes/dashboard.api.orders.$id.archive.tsx`
- Test: `app/routes/__tests__/dashboard.api.orders.detail.test.ts` (follow the conventions of the existing `app/routes/__tests__/dashboard.api.catalog.products.test.ts` — read it first)

**Interfaces:**
- Consumes: Task 7 executors, Task 9 `loadOrderDetail`, `requireDashboardSession`, `requireSameOrigin`, `dashboardJson`, `jsonOk`, `jsonError`.
- Produces the HTTP contract Task 11's client wraps. Response key style is snake_case (matches the refund route).

Detail route (complete):

```tsx
// app/routes/dashboard.api.orders.$id.tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError } from "~/lib/dashboard/http.server";
import { loadOrderDetail } from "~/lib/order/detail.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  const detail = await loadOrderDetail(session.shopId, String(params.id));
  if (!detail) return jsonError(404, "order_not_found");
  return dashboardJson(async () => ({ order: detail }));
}
```

(Adjust to `dashboardJson`'s actual contract — read `http.server.ts:129` first; if it wraps errors itself, move the null-check inside the callback and throw a `CalderynError` 404.)

Action routes all follow the refund route's skeleton: `requireSameOrigin` → `requireDashboardSession` → method check POST → parse+validate JSON body → executor → `jsonOk({...})`, mapping `CalderynError` status/code to `jsonError`. Body contracts:
- fulfill: `{ lines?: [{order_line_id: string, quantity: number}], tracking_number?: string, carrier?: string, notify: boolean, idempotency_key: string }` → `{ audit_id, fulfillment_id, order_state, fulfilled_units, notified }`
- cancel: `{ reason?: string, refund: boolean, restock: boolean, idempotency_key: string }` → `{ audit_id, order_state, refunded, restocked_lines }`
- notes: `{ body: string }` (1-2000 chars) → inserts `order_note` with `author_email = session.email ?? "merchant"` (check the DashboardSession type in `session.server.ts` for the email field name) → `{ note_id }`
- tags: `{ tags: string[] }` (each 1-60 chars, ≤20 tags, lowercase-trimmed, deduped) → full replace: delete shop+order rows then insert → `{ tags }`
- archive: `{ archived: boolean }` → sets/clears `orders.archived_at` → `{ archived }`

Notes/tags/archive validate the order exists (shop-scoped `orders` select id) → 404 otherwise. Tags/notes/archive apply to NATIVE orders only — reject `shopify:`-prefixed ids with 422 `imported_read_only`.

- [ ] **Step 1: Write failing route tests** — detail 404 on unknown id; fulfill happy-path returns `order_state`; cancel with refund returns `refunded: true`; tags round-trip replaces; archive toggles; every write route rejects a cross-origin request (assert `requireSameOrigin` behavior per the existing route-test convention).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement all six routes.**
- [ ] **Step 4: Run** — `npx vitest run app/routes` PASS.
- [ ] **Step 5: Gate + PR 2** — full gate (`typecheck`, `lint`, `build`, `npx vitest run app/lib app/routes`, `/code-review`), then commit + push + `gh pr create --title "orders: fulfillment/cancel spine, notes+tags+archive, transactional emails (phase 1, PR 2/3)"`.

```bash
git add app/routes/dashboard.api.orders.* app/routes/__tests__/dashboard.api.orders.detail.test.ts
git commit -m "orders/api: detail + fulfill + cancel + notes + tags + archive routes"
```

---

# Group C — order detail UI (PR 3)

### Task 11: client fetchers + route param plumbing

**Files:**
- Modify: `app/lib/dashboard/orders-client.ts`
- Modify: `app/components/dashboard/routes.ts`
- Test: extend the routes round-trip test if one exists (`grep -rn "buildPath\|parsePath" app/components/dashboard/__tests__/` first); otherwise add `app/components/dashboard/__tests__/routes-orders-param.test.ts` asserting `orders/<uuid>` ↔ `{screen:"orders", param:"<uuid>", sub:null}` and `orders/labels` still maps to the subtab.

**Interfaces:**
- Produces client functions Task 12 imports:

```ts
export async function fetchOrderDetail(sourceId: string): Promise<OrderDetail>            // GET  /dashboard/api/orders/:id  -> data.order
export async function fulfillOrder(orderId: string, args: { lines?: { orderLineId: string; quantity: number }[]; trackingNumber?: string; carrier?: string; notify: boolean; idempotencyKey: string }): Promise<{ orderState: string; fulfilledUnits: number; notified: boolean }>
export async function cancelOrder(orderId: string, args: { reason?: string; refund: boolean; restock: boolean; idempotencyKey: string }): Promise<{ orderState: string; refunded: boolean; restockedLines: number }>
export async function addOrderNote(orderId: string, body: string): Promise<void>
export async function setOrderTags(orderId: string, tags: string[]): Promise<string[]>
export async function setOrderArchived(orderId: string, archived: boolean): Promise<boolean>
```

  (snake_case⇄camelCase mapping in each wrapper, same style as `refundOrder`.)

- Routes: in `buildPath` case `"orders"` → `if (param) return \`orders/${encodeURIComponent(param)}\`;` before the sub branch. In `parsePath` case `"orders"` → keep the subtab branch, then fall through: `return { screen: "orders", param: b, sub: null };` (order detail ids — native uuid or `shopify:<uuid>` — never collide with the four subtab words).

- [ ] **Step 1: Failing routes test → Step 2: implement both files → Step 3: `npx vitest run app/components` + `npm run typecheck` PASS → Step 4: commit** — `git commit -m "dashboard/orders: detail client fetchers + orders/<id> route param"`

### Task 12: OrderDetail screen + Fulfill/Cancel modals

**Files:**
- Create: `app/components/dashboard/screens/OrderDetail.tsx`
- Create: `app/components/dashboard/screens/FulfillModal.tsx`
- Create: `app/components/dashboard/screens/CancelOrderModal.tsx`
- Modify: `app/components/dashboard/screens/Orders.tsx`

**Interfaces:**
- Consumes: Task 11 fetchers, `OrderDetail` types, `RefundModal`, `cd-*` primitives, `money`/`timeAgo`, `app.navigate("orders", id)` / `app.navigate("orders", null)` for back.
- Produces: `export default function OrderDetailScreen({ app, sourceId }: { app: DashboardCtx; sourceId: string })`.

Component structure (follow the Campaigns pattern of param-branching inside the screen):

- **Orders.tsx** top of the default export: `if (app.nav.param) return <OrderDetailScreen app={app} sourceId={app.nav.param} />;`
- Rows in `UnifiedOrdersList` become clickable: wrap the row div with `onClick={() => onOpen(\`${r.source === "shopify" ? "shopify:" : ""}${r.id}\`)}` + `style={{ cursor: "pointer" }}` + `role="button"`; the Refund button's onClick gains `e.stopPropagation()`. Add an `onOpen: (sourceId: string) => void` prop threaded from the screen (`(id) => app.navigate("orders", id)`).
- Split the status column into two: Payment pill (from `financialStatus` for native; existing pill for imported) and Fulfillment badge (`unfulfilled` when state paid, `Partially fulfilled`, `Fulfilled`, `Cancelled` when cancelled_at/state cancelled — native only; imported shows nothing). Update `STATE_LABEL`/`STATE_TONE` maps with `partially_fulfilled: "Partially fulfilled"` / orange.
- **OrderDetailScreen** layout (all `cd-*`):
  - fetch on mount (`fetchOrderDetail(sourceId)`), `TableSkeleton` while loading, `Placeholder` on error with retry. Before the fetch resolves, seed the header from the already-loaded list row when the screen has one (pass the matching `DisplayOrder` down from Orders.tsx as an optional `seed` prop) so ref/total/badges paint instantly, matching the screen-cache philosophy; the fetched detail then replaces it.
  - Header: back `Btn` (icon "arrow-left" — confirm the icon key exists in `CD_ICONS`, add the Lucide import + one registry line if not), `cd-h1` order ref, `cd-caption` created date + channel/source, Payment + Fulfillment badges; action bar: `Fulfill` (visible when `!readOnly && lines.some(l => l.fulfilledQuantity < l.quantity) && (state === "paid" || state === "partially_fulfilled")`), `Refund` (native + refundable states, reuses `RefundModal` — it needs an `OrderRow`-shaped object: build `{ id, ref, totalCents, remainingRefundableCents, currency, state }` from the detail; check `RefundModal`'s prop type and pass a compatible object), `Cancel` (state ∈ paid/partially_fulfilled/checkout_pending and !cancelledAt), overflow: Archive/Unarchive toggle.
  - `readOnly` banner for imported orders: `Card` with `cd-caption` "This order was placed and paid on Shopify. It's shown here as part of your imported history." — action buttons hidden.
  - Main column: Items card (line rows: title, sku caption, `qty × unit`, line total, per-line `Fulfilled n/m` caption); Payment card (subtotal / shipping / tax / discount when > 0 / total; then refunded −X and "Net" when refundedCents > 0); Fulfillments card (each: date, units, tracking number as copyable `tabular-nums` text, "Customer notified" caption when notifiedAt); Timeline card (events newest-first: dot + title + `timeAgo` + detail caption; note composer at top: `cd-input` + `Btn small` "Add note" → `addOrderNote` then refetch).
  - Side column: Customer card (email linking to `app.navigate("customers", buyer.id)`; "Guest" when null); Shipping address card; Tags card (pill list + inline add input + per-tag remove ×, saving via `setOrderTags` full-replace, native only).
- **FulfillModal** (`{ app, order, onClose, onDone }`): table of unfulfilled lines with a number input per line (default = remaining, min 0, max remaining), tracking number + carrier text inputs, "Email the customer a shipping confirmation" checkbox (default on), idempotency key minted once per open (same pattern as RefundModal), submit → `fulfillOrder` → toast `"Marked N item(s) fulfilled."` (+ " Customer notified." when notified) → onDone.
- **CancelOrderModal**: reason text input; when the order captured money (`remainingRefundableCents > 0`): "Refund the customer in full" checkbox (default on) and "Restock items" checkbox (default on); confirm copy "Cancelling can't be undone."; submit → `cancelOrder` → toast → onDone.

- [ ] **Step 1: Implement the three components + Orders.tsx edits** (component-level logic like the fulfillment-badge derivation goes in a small exported helper `fulfillmentBadge(state: string, cancelledAt: string | null): { label: string; tone: string } | null` in a new `app/components/dashboard/screens/order-status.ts` with a colocated unit test `order-status.test.ts` — same pattern as `campaign-creative-status.ts`).
- [ ] **Step 2: Test** — `npx vitest run app/components` PASS; `npm run typecheck` exit 0.
- [ ] **Step 3: Manual e2e on the local dev server** (recipe: source `.env.devserver.local` + `.env.local`, `prisma generate` with no other vite:dev running, `npm exec remix vite:dev`, `ENABLE_DEV_HMR=true`): list → click order → detail paints; fulfill a paid order partially → badge flips to Partially fulfilled → fulfill remainder → Fulfilled; add note + tag; cancel a fresh checkout_pending order; refund with restock and confirm the inventory screen shows the units back; open an imported order → read-only banner.
- [ ] **Step 4: Commit** — `git commit -m "dashboard/Orders: order detail screen, fulfill + cancel modals, split status badges"`

### Task 13: gate + PR 3 + close-out

- [ ] **Step 1:** Full gate: `/code-review` (fix blockers), `git diff --check`, `npm run typecheck`, `npm run lint`, `npm run build`, `npx vitest run`.
- [ ] **Step 2:** `gh pr create --title "dashboard/orders: order detail page + fulfillment UI (phase 1, PR 3/3)"` with the platform-pivot progress footer per CLAUDE.md.
- [ ] **Step 3:** After merge: `git worktree remove ../calderyn-orders-core` + delete the branch; update the memory file for the orders close-out project status.

## Verification checklist (whole phase)

- A paid order with tracked variants: fulfill → state `fulfilled`, shipping email logged as sent (check Resend dashboard or logs), `fulfillment.notified_at` set.
- Full refund with restock → `inventory_ledger` has one `restock` row per tracked variant; replaying the same idempotency key restocks nothing.
- Cancel of `checkout_pending` → reservation rows released (`inventory_reservation.state = 'released'`).
- Cancel with refund → order state `refunded`, `cancelled_at` set, UI badge reads Cancelled.
- Agentic order for an out-of-stock tracked variant → `OutOfStockError`, order cancelled, no lingering holds.
- Imported order detail renders read-only with correct line titles and refund history.
