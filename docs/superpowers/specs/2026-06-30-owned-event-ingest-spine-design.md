# Owned-event ingest spine — design

**Date:** 2026-06-30
**Platform-pivot step:** MVP build order **Step 5 — `extend:IngestETL`** (John's lane: owned-commerce data core).
**Branch / worktree:** `feat/ingest-spine` / `../calderyn-ingest` (cut from `origin/main` @ `66d8979`).
**Parent spec:** `docs/superpowers/specs/2026-06-27-calderyn-platform-pivot-design.md` (§ Step 5, § contract #3).

---

## Purpose

Re-point Calderyn's existing raw → transform → DLQ ingest spine so it records a **real owned sale** in
the analytics warehouse. Today the only source is Shopify webhooks (`raw_shopify_webhook`); the pivot
adds a second, parallel source — Calderyn's own checkout — emitting a fact-shaped `CHECKOUT_COMPLETED`
event that the spine turns into `order_fact` / `order_line_fact` / `attribution_fact`. The Shopify spine
is left **untouched** and runs in parallel until cutover (Step 9).

This is the data spine that makes an owned sale visible to the brain (ROAS, margin, velocity, grades)
without round-tripping through Shopify.

## Scope — what this is, and what it deliberately is NOT

The parent spec (written 2026-06-27) framed Step 5 as three changes: new order source, **capture PII
instead of stripping it**, and **flip inventory apply from observation-upsert to ledger-append**. Two of
those are now moot because of what Slices 1–2 landed after the spec was written:

1. **No inventory branch.** Slice 2's inventory engine (`app/lib/inventory/engine.server.ts`) already
   projects owned balances into `inventory_level_fact` synchronously on every mutation
   (`projectLevelFact`, called from `reserveStock` / `commitReservation` / `releaseReservation` /
   `adjustStock` / transfers). The warehouse's inventory view is therefore **already** fed from the owned
   ledger. An ingest inventory branch would duplicate that and risk diverging from the ledger that is the
   real source of truth. So the ingest spine does **not** touch inventory.

2. **No PII capture in the warehouse.** Slice 0/1's buyer identity landed a dedicated OLTP PII store
   (`buyer_dim` / `buyer_address` / `buyer_consent`, migration `20260629100000_buyer_identity.sql`) with
   the hard invariant, stated in that migration, that `order_fact` **never** gains a buyer-PII column.
   Buyer email/phone/address live in that OLTP store and only there. So the ingest spine does **not**
   capture PII into the warehouse; it carries a pseudonymous `buyer_id` UUID only.

3. **No refund branch.** Owned refunds are a first-class Calderyn action at Step 10 (`#3b`), out of MVP
   scope. The existing Shopify `refund_fact` path is unchanged.

**Net scope: `CHECKOUT_COMPLETED → order_fact / order_line_fact / attribution_fact (+ buyer_id)`,**
PII-free, idempotent, DLQ-backed, running alongside the untouched Shopify spine.

## Architecture

```
 Eric's checkout (OLTP: orders / cart / buyer_dim)  — payment confirmed
        │  emitOwnedEvent(shopId, CHECKOUT_COMPLETED{...})   ← the ONE helper Eric calls
        ▼
 raw_owned_event   (new intake table; event_id unique; DLQ-backed)
        │  transformPendingOwnedEvents()   (mirror of transformPendingWebhooks; separate loop + table)
        ▼
 applyOwnedOrder()  ──►  order_fact (+ buyer_id) · order_line_fact · applyAttribution()
```

The owned events live in their **own** intake table and their **own** transform loop, keyed by event
`type` — never mixed into `raw_shopify_webhook` / `canonicalTopic`. This is the parent spec's explicit
topic-collision guard (a native `CHECKOUT_COMPLETED` must never be dispatched by the Shopify branch).

### The owned-event schema (integration contract #3 — Eric builds his emit to this)

I own the ETL, so I define and publish this shape; Eric's checkout emit is reviewed against it via PR.

```ts
interface OwnedCheckoutCompleted {
  event_id: string;              // idempotency key = owned order id (orders.id); UNIQUE in raw_owned_event
  type: "CHECKOUT_COMPLETED";
  shop_id: string;               // uuid
  occurred_at: string;           // ISO 8601
  order: {
    external_id: string;         // owned order id → order_fact.external_id (onConflict shop_id,external_id)
    total_cents: number;
    subtotal_cents: number;
    shipping_cents: number;
    tax_cents: number;
    discount_cents: number;
    currency: string;
    financial_status: "paid";    // MVP records the PAID sale only
    buyer_id: string | null;     // pseudonymous ref into OLTP buyer_dim — NEVER email/phone/address
    click_ref?: string | null;   // ad click/UTM id for attribution
    landing_site?: string | null;
    referring_site?: string | null;
  };
  lines: Array<{
    external_line_id: string;
    variant_id: string | null;   // owned variant id; resolved to sku_dim.id at apply time
    quantity: number;
    price_cents: number;
    total_cents: number;
    grams?: number | null;
  }>;
}
```

This maps 1:1 onto what `parseOrderWebhook` already produces, so `applyOwnedOrder` reuses the existing
`order_fact` / `order_line_fact` upsert + `applyAttribution` logic almost verbatim — the only real
deltas are the source table, the idempotency key (`event_id` / owned order id instead of Shopify GID +
`source_version`), and the new `buyer_id` passthrough.

## Components (all new, isolated under `app/lib/ingest/owned/`)

| Piece | File | Responsibility |
|---|---|---|
| Intake + column | `supabase/migrations/<ts>_owned_event_ingest.sql` | `raw_owned_event` table + `alter table order_fact add column buyer_id uuid` |
| Schema + validator | `app/lib/ingest/owned/events.ts` | `OwnedCheckoutCompleted` type + `parseOwnedCheckoutCompleted()` — narrows the payload and **throws if any PII key is present** |
| Emit helper | `app/lib/ingest/owned/emit.server.ts` | `emitOwnedEvent()` — insert into `raw_owned_event` with `on conflict (event_id) do nothing` (idempotent). The single seam Eric's checkout calls |
| Transform loop | `app/lib/ingest/owned/transform.server.ts` | `transformPendingOwnedEvents()` — pull unprocessed rows, dispatch by `type`, DLQ on failure, stamp `processed_at` (mirror of `transformPendingWebhooks`, reuses `writeDlq`) |
| Apply | `app/lib/ingest/owned/apply.server.ts` | `applyOwnedOrder()` → `order_fact` (+`buyer_id`) / `order_line_fact` / `applyAttribution()` |
| Dev seed + proof | `app/lib/ingest/owned/dev-seed.server.ts` (+ non-prod route/test) | Emit a synthetic paid checkout and drive raw → transform → facts end-to-end |
| Worker wiring | `app/routes/cron.ingest.tsx` | Add a Phase 2b that calls `transformPendingOwnedEvents()` in its own try/catch, same isolation as the Shopify transform phase |

### `raw_owned_event` (intake table)

```
id            uuid pk default gen_random_uuid()
shop_id       uuid not null references shops(id) on delete cascade
event_id      text not null            -- idempotency key
type          text not null            -- 'CHECKOUT_COMPLETED'
payload       jsonb not null
received_at   timestamptz not null default now()
processed_at  timestamptz              -- null = unprocessed
unique (shop_id, event_id)
-- RLS enabled, service-role only (no policy), matching the inventory tables' pattern
```

## Data flow & invariants (each gets a test)

1. **PII stays out of the warehouse.** `applyOwnedOrder` writes only `buyer_id` (UUID) plus non-PII order
   fields to `order_fact`. `parseOwnedCheckoutCompleted` rejects a payload carrying any PII key
   (`email`, `phone`, `name`, `address*`) — fail visibly (rule 12), do not silently drop. A unit test
   asserts no PII column is ever written.
2. **Idempotent both ends.** `emitOwnedEvent` is `on conflict (shop_id, event_id) do nothing` → a double
   emit yields one intake row. `applyOwnedOrder` upserts `order_fact` on `(shop_id, external_id)` and
   `order_line_fact` on `(order_id, external_line_id)` → a double transform yields one fact. Test both.
3. **DLQ-backed, never loops.** Any apply failure routes to `ingestion_dlq` via `writeDlq` and still
   stamps `processed_at` so the row is not retried in a tight loop — identical to the Shopify loop.
4. **Reads before writes.** Same non-transactional discipline as `applyOrder`: resolve the variant →
   `sku_dim.id` map before writing the order header, so a transient read failure aborts before a partial
   write. `buyer_id` is passed through as-is (no cross-store read needed).
5. **Parallel, non-destructive.** The Shopify spine (`transformPendingWebhooks`, `raw_shopify_webhook`,
   `canonicalTopic`, the `apply*` upserters) is not modified. The two loops coexist until Step 9 cutover.

## Buyer link (warehouse)

`order_fact` gains a nullable `buyer_id uuid`. It is a **pseudonymous** reference into the OLTP
`buyer_dim` — never PII itself — that unlocks repeat-customer / LTV / cohort signals for the brain.
No hard cross-store FK from the warehouse into the OLTP buyer store (avoids coupling warehouse lifecycle
to OLTP deletes); the column is a soft reference, resolved under `shop_id` scope when a signal needs it.
Existing readers of `order_fact` are unaffected (nullable, additive).

## Testing

Vitest, mirroring `app/lib/ingest/__tests__/transform.test.ts` and `mappers.test.ts`:
- `parseOwnedCheckoutCompleted`: valid payload parses; **PII key present → throws**; missing required
  field → throws.
- `transformPendingOwnedEvents`: dispatches `CHECKOUT_COMPLETED` → `applyOwnedOrder`; unknown `type` is
  stamped + warned, not dispatched; apply failure → DLQ row + `processed_at` stamped.
- Idempotency: double `emitOwnedEvent` → 1 intake row; double transform → 1 `order_fact` + N lines.
- `applyOwnedOrder`: writes header + lines + `buyer_id`; `applyAttribution` invoked with `click_ref`;
  **no PII column written** (explicit assertion).
- End-to-end via dev-seed: synthetic paid checkout → `order_fact` row with correct totals + `buyer_id`.

## Out of scope / deferred

- Inventory events into the warehouse (Slice 2 engine already projects — see Scope §1).
- Buyer PII in the warehouse (lives in OLTP `buyer_dim` — see Scope §2).
- Owned refunds (`#3b`, Step 10).
- Eric's real checkout emit call site (he wires `emitOwnedEvent` into his payment-confirmed path; this
  spec ships a stub/dev producer to prove the consumer end-to-end).
- Cutover / dual-run gating (Step 9, `#13`).

## Housekeeping

- **Dashboard parity: exempt.** This is internal ingest plumbing with no merchant-facing surface
  (CLAUDE.md: "Pure infra/internal edits ... are exempt"). Noted explicitly per the parity rule.
- Migration numbering: John owns commerce-core migration numbering (contract #5). This migration
  sequences after the Slice 2 inventory migrations.
- Pre-commit gate (CLAUDE.md) applies before any commit: `/code-review`, typecheck, lint, build,
  `prisma validate` / `migrate diff` for the new migration, graphql-codegen if any query changed.
