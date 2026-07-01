# Owned-event Ingest Spine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record a real owned sale in the analytics warehouse — the owned checkout emits a fact-shaped `CHECKOUT_COMPLETED` event that a DLQ-backed transform loop turns into `order_fact` / `order_line_fact` / `attribution_fact` (+ pseudonymous `buyer_id`), running alongside the untouched Shopify ingest spine.

**Architecture:** A second intake table (`raw_owned_event`) and a second transform loop (`transformPendingOwnedEvents`) that mirror the existing Shopify spine but never share its topic dispatch (topic-collision guard). The owned checkout calls one seam — `emitOwnedEvent()` — after payment confirms; everything downstream reuses the existing `order_fact` upsert + `applyAttribution` logic almost verbatim. No inventory branch (Slice 2's engine already projects owned balances), no warehouse PII (OLTP `buyer_dim` owns it), no refund branch (deferred).

**Tech Stack:** TypeScript (strict, ES modules), Remix loader (`cron.ingest.tsx`), Supabase service-role client (`getSupabase`), Postgres (Supabase migrations), Vitest.

## Global Constraints

- **TypeScript only, strict.** No `any` without written justification (test fakes may use `any` with the existing eslint-disable header pattern). `tsc --noEmit` is authoritative.
- **Server-only modules end `.server.ts`** and reach Postgres via `getSupabase()` (service-role, BYPASSRLS), threading `shop_id` on every read/write.
- **Hard invariant — no buyer PII in the warehouse.** `order_fact` and every warehouse table carry a pseudonymous `buyer_id uuid` at most; never email/phone/name/address. The validator rejects any PII key (fail visibly, rule 12).
- **Idempotent + DLQ-backed.** Every intake insert and every fact upsert is idempotent; every apply failure routes to `ingestion_dlq` and still stamps `processed_at` so nothing loops.
- **Repo invariant — `sku_dim.id == variant_dim.id`** (`app/lib/catalog/project-sku-dim.server.ts:40`). An owned line's `variant_id` is already the `order_line_fact.sku_id`; no lookup map.
- **Do not modify the Shopify spine** (`transform.server.ts`, `mappers.server.ts`, `raw_shopify_webhook`, `canonicalTopic`, the `apply*` upserters). The owned path is strictly additive.
- **Browser-visible source hygiene** (CLAUDE.md): no AI/tool provenance in any comment or identifier. Server-only here, but keep comments technical and product-neutral.
- **Migration numbering:** John owns commerce-core numbering; this migration sequences after the latest (`20260630140000_acp_session.sql`).
- **Dashboard parity: exempt** — internal ingest plumbing, no merchant-facing surface.

---

### Task 1: Migration — `raw_owned_event` intake table + `order_fact.buyer_id`

**Files:**
- Create: `supabase/migrations/20260630170000_owned_event_ingest.sql`

**Interfaces:**
- Produces: table `public.raw_owned_event (id, shop_id, event_id, type, payload jsonb, received_at, processed_at)` with `unique (shop_id, event_id)`; column `public.order_fact.buyer_id uuid` (nullable).

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260630170000_owned_event_ingest.sql`:

```sql
-- Owned-event ingest intake (platform pivot Step 5 / IngestETL). Calderyn's own
-- checkout emits fact-shaped CHECKOUT_COMPLETED events here; transformPendingOwnedEvents
-- turns them into order_fact / order_line_fact / attribution_fact. Kept separate from
-- raw_shopify_webhook so a native event can never collide with Shopify topic dispatch.
-- Service-role only: RLS enabled with no policy (deny to anon/authenticated), matching
-- the inventory intake tables; grants revoked for defense in depth on a payload table.

create table if not exists public.raw_owned_event (
  id           uuid primary key default gen_random_uuid(),
  shop_id      uuid not null references public.shops(id) on delete cascade,
  event_id     text not null,
  type         text not null,
  payload      jsonb not null,
  received_at  timestamptz not null default now(),
  processed_at timestamptz,
  unique (shop_id, event_id)
);
create index if not exists raw_owned_event_unprocessed_idx
  on public.raw_owned_event (received_at)
  where processed_at is null;
alter table public.raw_owned_event enable row level security;
revoke all on table public.raw_owned_event from anon, authenticated;

-- Pseudonymous buyer link on the warehouse order (never PII). Nullable + additive so
-- every existing order_fact reader is unaffected; buyer PII stays in the OLTP buyer_dim.
alter table public.order_fact add column if not exists buyer_id uuid;
```

- [ ] **Step 2: Apply the migration to Supabase**

Apply via the Supabase MCP (`apply_migration`, name `owned_event_ingest`) — the repo tests on prod pre-launch. The change is additive and harmless (new table + nullable column).

- [ ] **Step 3: Confirm the table and column exist**

Use the Supabase MCP `list_tables` (schema `public`) and confirm `raw_owned_event` is present with the columns above, and `execute_sql`:

```sql
select column_name from information_schema.columns
where table_schema='public' and table_name='order_fact' and column_name='buyer_id';
```
Expected: one row, `buyer_id`.

- [ ] **Step 4: Confirm no new security advisors**

Run the Supabase MCP `get_advisors` (type `security`). Expected: no new ERROR-level advisor for `raw_owned_event` (RLS is enabled).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260630170000_owned_event_ingest.sql
git commit -m "ingest/owned: raw_owned_event intake + order_fact.buyer_id migration"
```

---

### Task 2: Owned-event schema + validator (`events.ts`)

**Files:**
- Create: `app/lib/ingest/owned/events.ts`
- Test: `app/lib/ingest/owned/__tests__/events.test.ts`

**Interfaces:**
- Consumes: `AttributionSignals` from `app/lib/attribution/types.ts` (`{ utm: Utm; clickIds: ClickIds; referringSite: string | null }`).
- Produces:
  - `const OWNED_CHECKOUT_COMPLETED = "CHECKOUT_COMPLETED"`
  - `interface OwnedOrderLine { external_line_id: string; variant_id: string | null; quantity: number; price_cents: number; total_cents: number; grams?: number | null }`
  - `interface OwnedCheckoutCompleted { event_id: string; type: typeof OWNED_CHECKOUT_COMPLETED; shop_id: string; occurred_at: string; order: { external_id: string; order_number: string; total_cents: number; subtotal_cents: number; shipping_cents: number; tax_cents: number; discount_cents: number; currency: string; financial_status: "paid"; buyer_id: string | null; attribution?: AttributionSignals }; lines: OwnedOrderLine[] }`
  - `function parseOwnedCheckoutCompleted(raw: unknown): OwnedCheckoutCompleted` — validates and returns the typed event; **throws** on a forbidden PII key, wrong type, or a missing/invalid required field.

- [ ] **Step 1: Write the failing test**

Create `app/lib/ingest/owned/__tests__/events.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseOwnedCheckoutCompleted, OWNED_CHECKOUT_COMPLETED } from "../events";

const SHOP = "00000000-0000-0000-0000-000000000001";

function validEvent(): Record<string, unknown> {
  return {
    event_id: "evt-1",
    type: OWNED_CHECKOUT_COMPLETED,
    shop_id: SHOP,
    occurred_at: "2026-06-30T12:00:00.000Z",
    order: {
      external_id: "owned-order-1",
      order_number: "#1001",
      total_cents: 2500,
      subtotal_cents: 2000,
      shipping_cents: 400,
      tax_cents: 100,
      discount_cents: 0,
      currency: "USD",
      financial_status: "paid",
      buyer_id: "11111111-1111-1111-1111-111111111111",
    },
    lines: [
      { external_line_id: "l1", variant_id: "22222222-2222-2222-2222-222222222222", quantity: 1, price_cents: 2000, total_cents: 2000, grams: 500 },
    ],
  };
}

describe("parseOwnedCheckoutCompleted", () => {
  it("parses a valid paid checkout event", () => {
    const e = parseOwnedCheckoutCompleted(validEvent());
    expect(e.event_id).toBe("evt-1");
    expect(e.order.buyer_id).toBe("11111111-1111-1111-1111-111111111111");
    expect(e.lines).toHaveLength(1);
    expect(e.lines[0].variant_id).toBe("22222222-2222-2222-2222-222222222222");
  });

  it("allows a null buyer_id (guest with no captured identity)", () => {
    const raw = validEvent();
    (raw.order as Record<string, unknown>).buyer_id = null;
    expect(parseOwnedCheckoutCompleted(raw).order.buyer_id).toBeNull();
  });

  it("throws when a PII key is present anywhere in the payload", () => {
    const raw = validEvent();
    (raw.order as Record<string, unknown>).email = "leak@example.com";
    expect(() => parseOwnedCheckoutCompleted(raw)).toThrow(/PII/i);
  });

  it("throws when financial_status is not 'paid'", () => {
    const raw = validEvent();
    (raw.order as Record<string, unknown>).financial_status = "pending";
    expect(() => parseOwnedCheckoutCompleted(raw)).toThrow(/paid/);
  });

  it("throws when a required numeric field is missing", () => {
    const raw = validEvent();
    delete (raw.order as Record<string, unknown>).total_cents;
    expect(() => parseOwnedCheckoutCompleted(raw)).toThrow(/total_cents/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/lib/ingest/owned/__tests__/events.test.ts`
Expected: FAIL — cannot resolve `../events`.

- [ ] **Step 3: Write the implementation**

Create `app/lib/ingest/owned/events.ts`:

```ts
// Owned-event schema + validator (platform pivot Step 5 / IngestETL). The owned
// checkout emits fact-shaped events into raw_owned_event; this module is the single
// source of truth for that contract and the guard that keeps buyer PII out of the
// analytics warehouse.
import type { AttributionSignals } from "../../attribution/types";

export const OWNED_CHECKOUT_COMPLETED = "CHECKOUT_COMPLETED" as const;

export interface OwnedOrderLine {
  external_line_id: string;
  variant_id: string | null; // owned variant_dim.id == sku_dim.id (repo invariant)
  quantity: number;
  price_cents: number;
  total_cents: number;
  grams?: number | null;
}

export interface OwnedCheckoutCompleted {
  event_id: string;
  type: typeof OWNED_CHECKOUT_COMPLETED;
  shop_id: string;
  occurred_at: string; // ISO 8601
  order: {
    external_id: string;
    order_number: string;
    total_cents: number;
    subtotal_cents: number;
    shipping_cents: number;
    tax_cents: number;
    discount_cents: number;
    currency: string;
    financial_status: "paid";
    buyer_id: string | null;
    attribution?: AttributionSignals;
  };
  lines: OwnedOrderLine[];
}

// Any of these keys anywhere in the payload is a PII leak — refuse the event
// (rule 12: fail visibly, never silently drop). Buyer PII lives ONLY in the OLTP
// buyer_dim store; the warehouse gets a pseudonymous buyer_id and nothing more.
const FORBIDDEN_PII_KEYS = new Set([
  "email", "phone", "name", "first_name", "last_name",
  "address", "address1", "address2", "shipping_address", "billing_address",
]);

function assertNoPii(obj: unknown, path: string): void {
  if (!obj || typeof obj !== "object") return;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (FORBIDDEN_PII_KEYS.has(k.toLowerCase())) {
      throw new Error(
        `owned event carries forbidden PII key '${path}${k}' — buyer PII must not reach the warehouse`,
      );
    }
    if (v && typeof v === "object") assertNoPii(v, `${path}${k}.`);
  }
}

function reqStr(v: unknown, name: string): string {
  if (typeof v !== "string" || v.length === 0) throw new Error(`owned event missing/invalid ${name}`);
  return v;
}
function reqNum(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`owned event missing/invalid ${name}`);
  return v;
}

export function parseOwnedCheckoutCompleted(raw: unknown): OwnedCheckoutCompleted {
  if (!raw || typeof raw !== "object") throw new Error("owned event payload is not an object");
  const p = raw as Record<string, unknown>;
  if (p.type !== OWNED_CHECKOUT_COMPLETED) {
    throw new Error(`unexpected owned event type ${String(p.type)}`);
  }
  assertNoPii(p, "");

  const order = p.order as Record<string, unknown> | undefined;
  if (!order || typeof order !== "object") throw new Error("owned event missing order");
  const linesRaw = Array.isArray(p.lines) ? (p.lines as Array<Record<string, unknown>>) : null;
  if (!linesRaw) throw new Error("owned event missing lines");

  const buyerId = order.buyer_id;
  if (buyerId !== null && typeof buyerId !== "string") {
    throw new Error("owned event order.buyer_id must be string|null");
  }
  if (order.financial_status !== "paid") {
    throw new Error(`owned event financial_status must be 'paid' (got ${String(order.financial_status)})`);
  }

  return {
    event_id: reqStr(p.event_id, "event_id"),
    type: OWNED_CHECKOUT_COMPLETED,
    shop_id: reqStr(p.shop_id, "shop_id"),
    occurred_at: reqStr(p.occurred_at, "occurred_at"),
    order: {
      external_id: reqStr(order.external_id, "order.external_id"),
      order_number: reqStr(order.order_number, "order.order_number"),
      total_cents: reqNum(order.total_cents, "order.total_cents"),
      subtotal_cents: reqNum(order.subtotal_cents, "order.subtotal_cents"),
      shipping_cents: reqNum(order.shipping_cents, "order.shipping_cents"),
      tax_cents: reqNum(order.tax_cents, "order.tax_cents"),
      discount_cents: reqNum(order.discount_cents, "order.discount_cents"),
      currency: reqStr(order.currency, "order.currency"),
      financial_status: "paid",
      buyer_id: (buyerId as string | null) ?? null,
      attribution: order.attribution as AttributionSignals | undefined,
    },
    lines: linesRaw.map((l, i) => ({
      external_line_id: reqStr(l.external_line_id, `lines[${i}].external_line_id`),
      variant_id: l.variant_id == null ? null : reqStr(l.variant_id, `lines[${i}].variant_id`),
      quantity: reqNum(l.quantity, `lines[${i}].quantity`),
      price_cents: reqNum(l.price_cents, `lines[${i}].price_cents`),
      total_cents: reqNum(l.total_cents, `lines[${i}].total_cents`),
      grams: l.grams == null ? null : reqNum(l.grams, `lines[${i}].grams`),
    })),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run app/lib/ingest/owned/__tests__/events.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/ingest/owned/events.ts app/lib/ingest/owned/__tests__/events.test.ts
git commit -m "ingest/owned: CHECKOUT_COMPLETED schema + PII-rejecting validator"
```

---

### Task 3: Emit seam + shared test fake (`emit.server.ts`)

**Files:**
- Create: `app/lib/ingest/owned/emit.server.ts`
- Create: `app/lib/ingest/owned/__tests__/fake-supabase.ts` (shared in-memory Supabase fake, reused by Tasks 4–5)
- Test: `app/lib/ingest/owned/__tests__/emit.test.ts`

**Interfaces:**
- Consumes: `parseOwnedCheckoutCompleted`, `OwnedCheckoutCompleted` (Task 2); `getSupabase` from `app/lib/supabase.server.ts`.
- Produces:
  - `function emitOwnedEvent(event: OwnedCheckoutCompleted): Promise<void>` — validates then upserts into `raw_owned_event` with `onConflict: "shop_id,event_id", ignoreDuplicates: true`.
  - `fake-supabase.ts` exports `makeFakeSupabase()` returning `{ client, calls }` where `calls` records `{ upserts, inserts, updates, deletes }` and `client.from(table)` is a chainable builder; plus `seed(table, rows)` and `failRead(table)` helpers.

- [ ] **Step 1: Write the shared test fake**

Create `app/lib/ingest/owned/__tests__/fake-supabase.ts`:

```ts
/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory fake supabase for owned-ingest tests */
// Minimal in-memory Supabase stand-in, modeled on the Shopify transform test harness
// (app/lib/ingest/__tests__/transform.test.ts). Records writes for assertions and can
// simulate a transient read failure per table.
export type Row = Record<string, any>;

export interface FakeCalls {
  upserts: Array<{ table: string; rows: any; opts?: any }>;
  inserts: Array<{ table: string; rows: any }>;
  updates: Array<{ table: string; set: any }>;
  deletes: Array<{ table: string }>;
}

export function makeFakeSupabase(opts?: {
  seed?: Record<string, Row[]>;
  // Table -> the id returned by upsert(...).select().single() (order_fact needs one).
  upsertReturns?: Record<string, Row>;
  failRead?: string[];
}) {
  const store: Record<string, Row[]> = { ...(opts?.seed ?? {}) };
  const failReadTables = new Set(opts?.failRead ?? []);
  const upsertReturns = opts?.upsertReturns ?? {};
  const calls: FakeCalls = { upserts: [], inserts: [], updates: [], deletes: [] };

  function builder(table: string): any {
    const filters: Array<[string, any]> = [];
    const matches = () => (store[table] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v));
    const readErr = () => (failReadTables.has(table) ? new Error(`read failed: ${table}`) : null);
    const api: any = {
      select: () => api,
      order: () => api,
      limit: () => api,
      is: () => api,
      eq: (k: string, v: any) => { filters.push([k, v]); return api; },
      maybeSingle: async () => ({ data: matches()[0] ?? null, error: readErr() }),
      single: async () => ({ data: upsertReturns[table] ?? matches()[0] ?? null, error: readErr() }),
      upsert: (rows: any, o?: any) => {
        calls.upserts.push({ table, rows, opts: o });
        const chain: any = {
          select: () => chain,
          single: async () => ({ data: upsertReturns[table] ?? { id: "order-uuid" }, error: null }),
          then: (res: (r: { data: any; error: null }) => unknown) => res({ data: [], error: null }),
        };
        return chain;
      },
      insert: (rows: any) => { calls.inserts.push({ table, rows }); return api; },
      update: (set: any) => { calls.updates.push({ table, set }); return api; },
      delete: () => { calls.deletes.push({ table }); return api; },
      then: (res: (r: { data: any; error: any }) => unknown) => res({ data: matches(), error: readErr() }),
    };
    return api;
  }

  return { client: { from: (t: string) => builder(t) } as any, calls, store };
}
```

- [ ] **Step 2: Write the failing test**

Create `app/lib/ingest/owned/__tests__/emit.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeSupabase } from "./fake-supabase";
import { OWNED_CHECKOUT_COMPLETED } from "../events";

const fake = makeFakeSupabase();
vi.mock("../../../supabase.server", () => ({ getSupabase: () => fake.client }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
let emitOwnedEvent: typeof import("../emit.server").emitOwnedEvent;

const SHOP = "00000000-0000-0000-0000-000000000001";
function event() {
  return {
    event_id: "evt-1", type: OWNED_CHECKOUT_COMPLETED, shop_id: SHOP,
    occurred_at: "2026-06-30T12:00:00.000Z",
    order: {
      external_id: "owned-order-1", order_number: "#1001", total_cents: 2500,
      subtotal_cents: 2000, shipping_cents: 400, tax_cents: 100, discount_cents: 0,
      currency: "USD", financial_status: "paid" as const, buyer_id: null,
    },
    lines: [{ external_line_id: "l1", variant_id: "22222222-2222-2222-2222-222222222222", quantity: 1, price_cents: 2000, total_cents: 2000 }],
  };
}

beforeEach(async () => {
  fake.calls.upserts.length = 0;
  ({ emitOwnedEvent } = await import("../emit.server"));
});

describe("emitOwnedEvent", () => {
  it("upserts the event into raw_owned_event with the idempotency conflict key", async () => {
    await emitOwnedEvent(event());
    expect(fake.calls.upserts).toHaveLength(1);
    const u = fake.calls.upserts[0];
    expect(u.table).toBe("raw_owned_event");
    expect(u.opts).toMatchObject({ onConflict: "shop_id,event_id", ignoreDuplicates: true });
    expect((u.rows as Record<string, unknown>).event_id).toBe("evt-1");
  });

  it("rejects an event that carries PII before any write", async () => {
    const bad = event();
    (bad.order as Record<string, unknown>).email = "leak@example.com";
    await expect(emitOwnedEvent(bad as never)).rejects.toThrow(/PII/i);
    expect(fake.calls.upserts).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run app/lib/ingest/owned/__tests__/emit.test.ts`
Expected: FAIL — cannot resolve `../emit.server`.

- [ ] **Step 4: Write the implementation**

Create `app/lib/ingest/owned/emit.server.ts`:

```ts
import { getSupabase } from "../../supabase.server";
import { parseOwnedCheckoutCompleted, type OwnedCheckoutCompleted } from "./events";

// The single seam the owned checkout calls after a payment is confirmed. Validates
// the event (rejecting any PII), then inserts it into raw_owned_event for the transform
// loop to pick up. Idempotent: a duplicate event_id is a no-op (checkout may retry).
// Never writes facts directly — the DLQ-backed transform does that.
export async function emitOwnedEvent(event: OwnedCheckoutCompleted): Promise<void> {
  const e = parseOwnedCheckoutCompleted(event); // throws on PII / malformed
  const { error } = await getSupabase()
    .from("raw_owned_event")
    .upsert(
      { shop_id: e.shop_id, event_id: e.event_id, type: e.type, payload: e as unknown as object },
      { onConflict: "shop_id,event_id", ignoreDuplicates: true },
    );
  if (error) throw error;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run app/lib/ingest/owned/__tests__/emit.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add app/lib/ingest/owned/emit.server.ts app/lib/ingest/owned/__tests__/emit.test.ts app/lib/ingest/owned/__tests__/fake-supabase.ts
git commit -m "ingest/owned: emitOwnedEvent seam + shared test fake"
```

---

### Task 4: Apply owned order → warehouse (`apply.server.ts`)

**Files:**
- Create: `app/lib/ingest/owned/apply.server.ts`
- Test: `app/lib/ingest/owned/__tests__/apply.test.ts`

**Interfaces:**
- Consumes: `OwnedCheckoutCompleted` (Task 2); `applyAttribution(shopId, orderId, revenueCents, signals: AttributionSignals, sb)` from `app/lib/attribution/apply.server.ts`; `AttributionSignals` from `app/lib/attribution/types.ts`; `getSupabase`.
- Produces: `function applyOwnedOrder(event: OwnedCheckoutCompleted): Promise<number>` — upserts `order_fact` (onConflict `shop_id,external_id`) with `buyer_id`, calls `applyAttribution`, upserts `order_line_fact` (onConflict `order_id,external_line_id`) with `sku_id = line.variant_id`. Returns fact-row count (1 + lines).

- [ ] **Step 1: Write the failing test**

Create `app/lib/ingest/owned/__tests__/apply.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeSupabase } from "./fake-supabase";
import { OWNED_CHECKOUT_COMPLETED } from "../events";

const fake = makeFakeSupabase({ upsertReturns: { order_fact: { id: "order-uuid" } } });
vi.mock("../../../supabase.server", () => ({ getSupabase: () => fake.client }));
// applyAttribution reaches Supabase itself; stub it and assert the call args.
const applyAttribution = vi.fn().mockResolvedValue(undefined);
vi.mock("../../../attribution/apply.server", () => ({ applyAttribution: (...a: unknown[]) => applyAttribution(...a) }));

let applyOwnedOrder: typeof import("../apply.server").applyOwnedOrder;
const SHOP = "00000000-0000-0000-0000-000000000001";
const VARIANT = "22222222-2222-2222-2222-222222222222";
const BUYER = "11111111-1111-1111-1111-111111111111";

function event() {
  return {
    event_id: "evt-1", type: OWNED_CHECKOUT_COMPLETED, shop_id: SHOP,
    occurred_at: "2026-06-30T12:00:00.000Z",
    order: {
      external_id: "owned-order-1", order_number: "#1001", total_cents: 2500,
      subtotal_cents: 2000, shipping_cents: 400, tax_cents: 100, discount_cents: 0,
      currency: "USD", financial_status: "paid" as const, buyer_id: BUYER,
      attribution: { utm: { utm_source: "meta" }, clickIds: {}, referringSite: "https://ig.example" },
    },
    lines: [{ external_line_id: "l1", variant_id: VARIANT, quantity: 1, price_cents: 2000, total_cents: 2000, grams: 500 }],
  };
}

beforeEach(async () => {
  fake.calls.upserts.length = 0; applyAttribution.mockClear();
  ({ applyOwnedOrder } = await import("../apply.server"));
});

describe("applyOwnedOrder", () => {
  it("writes order_fact with buyer_id and NO PII column", async () => {
    await applyOwnedOrder(event() as never);
    const of = fake.calls.upserts.find((u) => u.table === "order_fact")!;
    const row = of.rows as Record<string, unknown>;
    expect(row.buyer_id).toBe(BUYER);
    expect(row.external_id).toBe("owned-order-1");
    expect(row.utm_source).toBe("meta");
    for (const k of ["email", "phone", "name", "address", "shipping_address"]) {
      expect(row).not.toHaveProperty(k);
    }
    expect(of.opts).toMatchObject({ onConflict: "shop_id,external_id" });
  });

  it("writes order_line_fact with sku_id = variant_id (repo invariant)", async () => {
    await applyOwnedOrder(event() as never);
    const lf = fake.calls.upserts.find((u) => u.table === "order_line_fact")!;
    const rows = lf.rows as Array<Record<string, unknown>>;
    expect(rows[0].sku_id).toBe(VARIANT);
    expect(rows[0].order_id).toBe("order-uuid");
    expect(lf.opts).toMatchObject({ onConflict: "order_id,external_line_id" });
  });

  it("invokes applyAttribution with the order's signals and revenue", async () => {
    await applyOwnedOrder(event() as never);
    expect(applyAttribution).toHaveBeenCalledTimes(1);
    const [shopId, orderId, revenue, signals] = applyAttribution.mock.calls[0];
    expect(shopId).toBe(SHOP);
    expect(orderId).toBe("order-uuid");
    expect(revenue).toBe(2500);
    expect(signals).toMatchObject({ utm: { utm_source: "meta" }, referringSite: "https://ig.example" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/lib/ingest/owned/__tests__/apply.test.ts`
Expected: FAIL — cannot resolve `../apply.server`.

- [ ] **Step 3: Write the implementation**

Create `app/lib/ingest/owned/apply.server.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "../../supabase.server";
import { applyAttribution } from "../../attribution/apply.server";
import type { AttributionSignals } from "../../attribution/types";
import type { OwnedCheckoutCompleted } from "./events";

const EMPTY_SIGNALS: AttributionSignals = { utm: {}, clickIds: {}, referringSite: null };

// Write one owned paid order into the analytics warehouse: order_fact (+buyer_id),
// order_line_fact, and attribution. PII-free by construction — only buyer_id (a
// pseudonymous OLTP ref) lands in order_fact. Idempotent via the same onConflict keys
// the Shopify path uses. No sku_dim lookup is needed: an owned line's variant_id IS
// the sku_dim.id (repo invariant sku_dim.id == variant_dim.id), so the header is safe
// to write first; a variant not yet projected to sku_dim fails the order_line_fact FK
// and sends the whole event to the DLQ (visible), never a silent sku_id=null.
export async function applyOwnedOrder(event: OwnedCheckoutCompleted): Promise<number> {
  const sb = getSupabase();
  const o = event.order;
  const parsedVersion = Date.parse(event.occurred_at);
  const sourceVersion = Number.isFinite(parsedVersion) ? parsedVersion : 0;
  const signals = o.attribution ?? EMPTY_SIGNALS;

  const { data: oUp, error: oErr } = await sb
    .from("order_fact")
    .upsert(
      {
        shop_id: event.shop_id,
        external_id: o.external_id,
        order_number: o.order_number,
        created_at_source: event.occurred_at,
        total_cents: o.total_cents,
        subtotal_cents: o.subtotal_cents,
        shipping_cents: o.shipping_cents,
        tax_cents: o.tax_cents,
        discount_cents: o.discount_cents,
        currency: o.currency,
        financial_status: o.financial_status,
        source_version: sourceVersion,
        landing_site: null,
        referring_site: signals.referringSite ?? null,
        utm_source: signals.utm.utm_source ?? null,
        utm_medium: signals.utm.utm_medium ?? null,
        utm_campaign: signals.utm.utm_campaign ?? null,
        utm_content: signals.utm.utm_content ?? null,
        utm_term: signals.utm.utm_term ?? null,
        buyer_id: o.buyer_id,
      },
      { onConflict: "shop_id,external_id" },
    )
    .select("id")
    .single();
  if (oErr) throw oErr;
  const orderId = (oUp as { id: string }).id;

  // Best-effort attribution (never aborts ingestion; a failure surfaces via the
  // caller's DLQ path), mirroring the Shopify applyOrder contract.
  await applyAttribution(event.shop_id, orderId, o.total_cents, signals, sb as unknown as SupabaseClient);

  if (!event.lines.length) return 1;

  const lineRows = event.lines.map((l) => ({
    shop_id: event.shop_id,
    order_id: orderId,
    sku_id: l.variant_id, // == sku_dim.id (repo invariant)
    external_line_id: l.external_line_id,
    quantity: l.quantity,
    price_cents: l.price_cents,
    total_cents: l.total_cents,
    grams: l.grams ?? null,
  }));

  const { error: lErr } = await sb
    .from("order_line_fact")
    .upsert(lineRows, { onConflict: "order_id,external_line_id" });
  if (lErr) throw lErr;

  return 1 + lineRows.length;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run app/lib/ingest/owned/__tests__/apply.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/ingest/owned/apply.server.ts app/lib/ingest/owned/__tests__/apply.test.ts
git commit -m "ingest/owned: applyOwnedOrder writes PII-free order facts + buyer_id"
```

---

### Task 5: Owned transform loop (`transform.server.ts`)

**Files:**
- Create: `app/lib/ingest/owned/transform.server.ts`
- Test: `app/lib/ingest/owned/__tests__/transform.test.ts`

**Interfaces:**
- Consumes: `applyOwnedOrder` (Task 4); `parseOwnedCheckoutCompleted`, `OWNED_CHECKOUT_COMPLETED` (Task 2); `writeDlq` from `app/lib/ingest/dlq.server.ts`; `getSupabase`.
- Produces: `function transformPendingOwnedEvents(): Promise<{ processed: number; facts: number; dlq: number }>`.

- [ ] **Step 1: Write the failing test**

Create `app/lib/ingest/owned/__tests__/transform.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeSupabase } from "./fake-supabase";
import { OWNED_CHECKOUT_COMPLETED } from "../events";

const SHOP = "00000000-0000-0000-0000-000000000001";
const VARIANT = "22222222-2222-2222-2222-222222222222";

function rawRow(id: string, type = OWNED_CHECKOUT_COMPLETED, overrides: Record<string, unknown> = {}) {
  const payload = {
    event_id: id, type, shop_id: SHOP, occurred_at: "2026-06-30T12:00:00.000Z",
    order: {
      external_id: `owned-${id}`, order_number: "#1", total_cents: 2000, subtotal_cents: 2000,
      shipping_cents: 0, tax_cents: 0, discount_cents: 0, currency: "USD",
      financial_status: "paid", buyer_id: null, ...overrides,
    },
    lines: [{ external_line_id: `${id}-l1`, variant_id: VARIANT, quantity: 1, price_cents: 2000, total_cents: 2000 }],
  };
  return { id, shop_id: SHOP, type, payload, processed_at: null };
}

const applyOwnedOrder = vi.fn().mockResolvedValue(2);
vi.mock("../apply.server", () => ({ applyOwnedOrder: (...a: unknown[]) => applyOwnedOrder(...a) }));

let fake: ReturnType<typeof makeFakeSupabase>;
let transformPendingOwnedEvents: typeof import("../transform.server").transformPendingOwnedEvents;

async function load(seedRows: Row[]) {
  fake = makeFakeSupabase({ seed: { raw_owned_event: seedRows } });
  vi.doMock("../../../supabase.server", () => ({ getSupabase: () => fake.client }));
  ({ transformPendingOwnedEvents } = await import("../transform.server"));
}
type Row = Record<string, unknown>;

beforeEach(() => { vi.resetModules(); applyOwnedOrder.mockClear(); applyOwnedOrder.mockResolvedValue(2); });

describe("transformPendingOwnedEvents", () => {
  it("dispatches CHECKOUT_COMPLETED to applyOwnedOrder and stamps processed_at", async () => {
    await load([rawRow("evt-1")]);
    const res = await transformPendingOwnedEvents();
    expect(applyOwnedOrder).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ processed: 1, facts: 2, dlq: 0 });
    expect(fake.calls.updates.some((u) => u.table === "raw_owned_event")).toBe(true);
  });

  it("skips an unknown event type without dispatching", async () => {
    await load([rawRow("evt-2", "SOMETHING_ELSE")]);
    const res = await transformPendingOwnedEvents();
    expect(applyOwnedOrder).not.toHaveBeenCalled();
    expect(res.processed).toBe(1);
    expect(res.facts).toBe(0);
  });

  it("routes an apply failure to the DLQ and still stamps processed_at (no loop)", async () => {
    applyOwnedOrder.mockRejectedValueOnce(new Error("boom"));
    await load([rawRow("evt-3")]);
    const res = await transformPendingOwnedEvents();
    expect(res.dlq).toBe(1);
    expect(fake.calls.inserts.some((i) => i.table === "ingestion_dlq")).toBe(true);
    expect(fake.calls.updates.some((u) => u.table === "raw_owned_event")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/lib/ingest/owned/__tests__/transform.test.ts`
Expected: FAIL — cannot resolve `../transform.server`.

- [ ] **Step 3: Write the implementation**

Create `app/lib/ingest/owned/transform.server.ts`:

```ts
import { getSupabase } from "../../supabase.server";
import { writeDlq } from "../dlq.server";
import { applyOwnedOrder } from "./apply.server";
import { parseOwnedCheckoutCompleted, OWNED_CHECKOUT_COMPLETED } from "./events";

const BATCH = 200;

export type OwnedTransformResult = { processed: number; facts: number; dlq: number };

// Owned-event sibling of transformPendingWebhooks. Separate intake table + loop so a
// native CHECKOUT_COMPLETED can never be dispatched by the Shopify topic branch (the
// parent spec's topic-collision guard). DLQ-backed and processed_at-stamped so a poison
// event never loops.
export async function transformPendingOwnedEvents(): Promise<OwnedTransformResult> {
  const sb = getSupabase();
  const res: OwnedTransformResult = { processed: 0, facts: 0, dlq: 0 };

  const { data: rows, error } = await sb
    .from("raw_owned_event")
    .select("id, shop_id, type, payload")
    .is("processed_at", null)
    .order("received_at", { ascending: true })
    .limit(BATCH);
  if (error) throw error;

  for (const row of rows ?? []) {
    try {
      if (row.type === OWNED_CHECKOUT_COMPLETED) {
        const event = parseOwnedCheckoutCompleted(row.payload);
        res.facts += await applyOwnedOrder(event);
      } else {
        // Unexpected type — stamp it so it doesn't loop, but stay visible (rule 12).
        console.warn(`[ingest] owned transform: skipping unhandled event type ${row.type}`);
      }
      await sb.from("raw_owned_event").update({ processed_at: new Date().toISOString() }).eq("id", row.id);
      res.processed += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await writeDlq({
        shopId: row.shop_id,
        jobKind: `owned_transform:${row.type}`,
        errorKind: "owned_transform_failed",
        errorMessage: message,
        payload: row.payload,
      });
      await sb.from("raw_owned_event").update({ processed_at: new Date().toISOString() }).eq("id", row.id);
      res.dlq += 1;
    }
  }
  return res;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run app/lib/ingest/owned/__tests__/transform.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/ingest/owned/transform.server.ts app/lib/ingest/owned/__tests__/transform.test.ts
git commit -m "ingest/owned: DLQ-backed transformPendingOwnedEvents loop"
```

---

### Task 6: Dev-seed producer (`dev-seed.server.ts`)

**Files:**
- Create: `app/lib/ingest/owned/dev-seed.server.ts`
- Test: `app/lib/ingest/owned/__tests__/dev-seed.test.ts`

**Interfaces:**
- Consumes: `emitOwnedEvent` (Task 3).
- Produces: `function seedOwnedCheckout(params: { shopId: string; variantId: string; eventId: string; buyerId?: string | null }): Promise<void>` — emits one synthetic paid `CHECKOUT_COMPLETED`. Throws in production unless `OWNED_INGEST_DEV_SEED === "1"`.

- [ ] **Step 1: Write the failing test**

Create `app/lib/ingest/owned/__tests__/dev-seed.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const emitOwnedEvent = vi.fn().mockResolvedValue(undefined);
vi.mock("../emit.server", () => ({ emitOwnedEvent: (...a: unknown[]) => emitOwnedEvent(...a) }));

let seedOwnedCheckout: typeof import("../dev-seed.server").seedOwnedCheckout;
beforeEach(async () => {
  emitOwnedEvent.mockClear();
  ({ seedOwnedCheckout } = await import("../dev-seed.server"));
});

describe("seedOwnedCheckout", () => {
  it("emits one valid paid checkout event", async () => {
    await seedOwnedCheckout({ shopId: "s1", variantId: "v1", eventId: "e1" });
    expect(emitOwnedEvent).toHaveBeenCalledTimes(1);
    const ev = emitOwnedEvent.mock.calls[0][0] as Record<string, any>;
    expect(ev.type).toBe("CHECKOUT_COMPLETED");
    expect(ev.order.financial_status).toBe("paid");
    expect(ev.lines[0].variant_id).toBe("v1");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/lib/ingest/owned/__tests__/dev-seed.test.ts`
Expected: FAIL — cannot resolve `../dev-seed.server`.

- [ ] **Step 3: Write the implementation**

Create `app/lib/ingest/owned/dev-seed.server.ts`:

```ts
import { emitOwnedEvent } from "./emit.server";
import type { OwnedCheckoutCompleted } from "./events";

// Non-prod producer that stands in for the owned checkout's emit call, so the owned
// ingest path can be proven end-to-end (emit -> raw_owned_event -> transform -> facts)
// before the real checkout wires emitOwnedEvent. Disabled in production unless the
// OWNED_INGEST_DEV_SEED escape hatch is set (for a one-off prod smoke test).
export async function seedOwnedCheckout(params: {
  shopId: string;
  variantId: string;
  eventId: string;
  buyerId?: string | null;
}): Promise<void> {
  if (process.env.NODE_ENV === "production" && process.env.OWNED_INGEST_DEV_SEED !== "1") {
    throw new Error("seedOwnedCheckout is disabled in production");
  }
  const event: OwnedCheckoutCompleted = {
    event_id: params.eventId,
    type: "CHECKOUT_COMPLETED",
    shop_id: params.shopId,
    occurred_at: new Date().toISOString(),
    order: {
      external_id: `owned-order-${params.eventId}`,
      order_number: `#DEV-${params.eventId.slice(0, 6)}`,
      total_cents: 2500,
      subtotal_cents: 2000,
      shipping_cents: 400,
      tax_cents: 100,
      discount_cents: 0,
      currency: "USD",
      financial_status: "paid",
      buyer_id: params.buyerId ?? null,
      attribution: { utm: {}, clickIds: {}, referringSite: null },
    },
    lines: [
      {
        external_line_id: `${params.eventId}-1`,
        variant_id: params.variantId,
        quantity: 1,
        price_cents: 2000,
        total_cents: 2000,
        grams: 500,
      },
    ],
  };
  await emitOwnedEvent(event);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run app/lib/ingest/owned/__tests__/dev-seed.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add app/lib/ingest/owned/dev-seed.server.ts app/lib/ingest/owned/__tests__/dev-seed.test.ts
git commit -m "ingest/owned: dev-seed producer for end-to-end proof"
```

---

### Task 7: Wire the owned transform into the ingest cron (`cron.ingest.tsx`)

**Files:**
- Modify: `app/routes/cron.ingest.tsx` (import + `summary` fields + Phase 2b block)

**Interfaces:**
- Consumes: `transformPendingOwnedEvents` (Task 5).
- Produces: the cron `summary` JSON gains `ownedTransform: { processed, facts, dlq }` and `ownedTransformError: string | null`.

- [ ] **Step 1: Add the import**

In `app/routes/cron.ingest.tsx`, directly below the existing `import { transformPendingWebhooks } from "~/lib/ingest/transform.server";` line, add:

```ts
import { transformPendingOwnedEvents } from "~/lib/ingest/owned/transform.server";
```

- [ ] **Step 2: Add the summary fields**

In the `summary` object literal, directly below the existing:

```ts
    transform: { processed: 0, facts: 0, dlq: 0 },
    transformError: null as string | null,
```

add:

```ts
    ownedTransform: { processed: 0, facts: 0, dlq: 0 },
    ownedTransformError: null as string | null,
```

- [ ] **Step 3: Add the Phase 2b block**

Directly after the existing Phase 2 `try/catch` that assigns `summary.transform`, add:

```ts
  // Phase 2b: transform queued OWNED checkout events (isolated like Phase 2, so an
  // owned-transform failure doesn't abort the Shopify transform or the response).
  try {
    summary.ownedTransform = await transformPendingOwnedEvents();
  } catch (err) {
    summary.ownedTransformError = err instanceof Error ? err.message : String(err);
    console.error("[cron.ingest] owned transform phase failed", err);
  }
```

- [ ] **Step 4: Verify typecheck passes**

Run: `npm run typecheck`
Expected: exit 0 (no errors in `cron.ingest.tsx`).

- [ ] **Step 5: Commit**

```bash
git add app/routes/cron.ingest.tsx
git commit -m "routes/cron.ingest: run the owned-event transform (Phase 2b)"
```

---

### Task 8: End-to-end proof + full pre-commit gate

**Files:** none new — verification only.

- [ ] **Step 1: Run the full owned-ingest test suite**

Run: `npx vitest run app/lib/ingest/owned`
Expected: PASS — all files (events 5, emit 2, apply 3, transform 3, dev-seed 1 = 14 tests).

- [ ] **Step 2: End-to-end proof against Supabase (dev-seed → facts)**

Pick a real demo shop + a real owned variant id (repo memory: `calderyn-test` is a seeded demo store). In a scratch script or the Remix server console, call:

```ts
import { seedOwnedCheckout } from "~/lib/ingest/owned/dev-seed.server";
import { transformPendingOwnedEvents } from "~/lib/ingest/owned/transform.server";
await seedOwnedCheckout({ shopId: "<demo shop uuid>", variantId: "<owned variant_dim.id>", eventId: "e2e-1" });
console.log(await transformPendingOwnedEvents());
```

Then confirm via the Supabase MCP `execute_sql`:

```sql
select external_id, total_cents, buyer_id from public.order_fact where external_id = 'owned-order-e2e-1';
select count(*) from public.order_line_fact lf
  join public.order_fact f on f.id = lf.order_id where f.external_id = 'owned-order-e2e-1';
```
Expected: one `order_fact` row (total 2500, `buyer_id` null), one `order_line_fact`. Run the transform a second time and re-query — still exactly one of each (idempotency proven on the real DB). Then delete the two proof rows.

- [ ] **Step 3: Run the pre-commit gate (CLAUDE.md)**

Run in order, paste each result (rule 12 — do not assert success without evidence):

```bash
npm run typecheck   # exit 0
npm run lint        # exit 0, no warnings on touched files
npm run build       # exit 0 (Remix + Vite + verify-client-bundle)
npx prisma validate # unchanged prisma schema — sanity only
```

- [ ] **Step 4: Run `/code-review` on the working tree**

Resolve every blocker; downgrade any nit explicitly with a one-line justification.

- [ ] **Step 5: Patch sanity**

Run: `git diff --stat origin/main` and `git diff --check`
Confirm: no stray `console.log`, `.only`, `TODO(me)`, commented-out blocks, or AI/provenance markers; the only browser-reachable change is server-side.

- [ ] **Step 6: Final integration commit (if any gate fixups were made)**

```bash
git add -A
git commit -m "ingest/owned: pre-commit gate fixups"
```

Do not push or open a PR until John asks. When he does, the PR body must include the platform-pivot progress report (CLAUDE.md): what's remaining in the 12-step MVP build order and the John↔Eric big-picture status.

---

## Self-Review

**Spec coverage:**
- `CHECKOUT_COMPLETED → order_fact/order_line_fact/attribution_fact (+buyer_id)` → Tasks 4 (apply) + 5 (transform). ✓
- `raw_owned_event` intake + `order_fact.buyer_id` → Task 1. ✓
- `emitOwnedEvent` seam → Task 3. ✓
- PII-free invariant + validator that rejects PII → Task 2 (validator) + Task 4 (no-PII assertion test). ✓
- Idempotency (double emit → 1 row; double transform → 1 fact) → Task 3 (onConflict) + Task 8 Step 2 (real-DB re-run). ✓
- DLQ-backed, stamps processed_at → Task 5. ✓
- Separate table/loop (topic-collision guard) → Task 1 + Task 5. ✓
- No inventory branch / no PII capture / no refund branch (scope cuts) → honored (none built). ✓
- Dev/test producer → Task 6. ✓
- Worker wiring → Task 7. ✓
- Dashboard parity exempt → noted (Global Constraints). ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"; every code + test step shows full code. ✓

**Type consistency:** `OwnedCheckoutCompleted` / `OwnedOrderLine` / `parseOwnedCheckoutCompleted` / `emitOwnedEvent` / `applyOwnedOrder` / `transformPendingOwnedEvents` / `seedOwnedCheckout` used identically across tasks. `applyAttribution(shopId, orderId, revenueCents, signals, sb)` matches `app/lib/attribution/apply.server.ts`. `writeDlq({ shopId, jobKind, errorKind, errorMessage, payload })` matches `app/lib/ingest/dlq.server.ts`. onConflict keys (`shop_id,external_id`; `order_id,external_line_id`; `shop_id,event_id`) match the existing spine + the migration. ✓

**One open risk (flagged, not blocking):** `order_line_fact.sku_id` is written directly as `variant_id` on the invariant `sku_dim.id == variant_dim.id`. If a sold variant was never projected to `sku_dim`, the row fails its FK and the whole event DLQs (visible, intended). The E2E step (Task 8) uses a real projected variant, so it exercises the happy path; watch the DLQ on first real checkout traffic.
