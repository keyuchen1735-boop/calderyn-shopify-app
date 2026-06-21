# Agentic Reorder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the dead `create_po_draft` Calibration pair into a live, learnable engine action that observes supplier lead time + batch size from restock history, computes when/how-much to reorder, and drafts a ready-to-send PO — fully agentic, zero merchant data entry.

**Architecture:** Three new isolated server modules (restock observer, pure reorder math, PO draft executor) feed the **existing** Calibration machinery. The only engine change is adding `create_po_draft` to `HAS_EXECUTOR` and flipping its tier to `reversible`; everything else (scoring, queue, graduation, learning) reuses what slices 0–5 already shipped. A new RLS-scoped `sku_reorder_belief` table holds per-SKU learned lead time + batch size, updated nightly and nudged by manual restocks observed via the existing inventory webhook.

**Tech Stack:** TypeScript (strict, ES modules), Remix loaders/actions, Supabase Postgres (RLS `ENABLE + FORCE`, `security_invoker` views), Vitest, existing `action_audit` / `pair_calibration` / `alerts` infra.

## Global Constraints

- TypeScript only; no `any` without written justification (prefer `unknown` + narrowing). `tsc --noEmit` is authoritative.
- `.server.ts` files are server-only; never import from a client module.
- All new Supabase objects ship as a **new migration** under `supabase/migrations/`; never hand-edit existing migrations. New tables: RLS `ENABLE + FORCE` scoped to `shop_id`, service_role bypass only. New views: `security_invoker = on`.
- All Calibration safety invariants I1–I10 (see [calibration design](../specs/2026-06-20-calderyn-calibration-design.md) §9) apply unchanged.
- Confidence/tier math has ONE source of truth: `app/lib/calibration/confidence.ts`. `HAS_EXECUTOR` there must stay in sync with `ExecutableKind` semantics.
- Dashboard parity is MANDATORY (CLAUDE.md): every merchant-facing change mirrors into the dashboard surface or ships with an explicit dashboard TODO.
- Pre-commit gate before every commit: `npm run typecheck` (exit 0) → `npm run lint --max-warnings=0` on touched files → `npm run build` → `npx prisma validate` if schema changed. New Supabase migration: confirm it applies. Paste results; never assert success without evidence.
- One worktree per slice: `git worktree add ../calderyn-reorder-<slice> -b feat/reorder-<slice>`.
- Reference the spec: [docs/superpowers/specs/2026-06-21-agentic-reorder-design.md](../specs/2026-06-21-agentic-reorder-design.md).

---

## Slice 0: Discovery (verify schemas before coding)

These facts are assumed throughout. Verify them first; if any differ, adjust the dependent task's column names. This is a read-only task, no commit.

- [ ] **Step 1: Confirm `sku_velocity` columns**

Run (via supabase MCP `execute_sql` or psql):
```sql
select column_name, data_type from information_schema.columns
where table_name = 'sku_velocity' order by ordinal_position;
```
Expected: a `shop_id`, `sku_id`, `window_days` (values 1/7/28), and a units/velocity column. Record the exact velocity column name — Task 2.2 uses it.

- [ ] **Step 2: Confirm `inventory_level_fact` columns**

```sql
select column_name, data_type from information_schema.columns
where table_name = 'inventory_level_fact' order by ordinal_position;
```
Expected: `shop_id, sku_id, location_id, available, observed_at, source_version`. (Used by the restock observer.)

- [ ] **Step 3: Confirm `cogs_fact` has a per-SKU unit cost**

```sql
select column_name, data_type from information_schema.columns
where table_name = 'cogs_fact' order by ordinal_position;
```
Record the unit-cost column (cents) — the PO draft executor uses it for `po.lines[].unit_cost_cents`. If absent, the executor omits cost (draft still valid).

- [ ] **Step 4: Confirm the alert insert path for `reorder_timing`**

Run:
```
grep -rn "reorder_timing" app/lib/ --include=*.ts
```
Expected: it's a `DetectorId` in `labels.ts` mapped to `["create_po_draft","snooze_alert"]`. Record where `reorder_timing` alerts are currently written (engine side) so Task 5.1 attaches the draft plan to `alerts.evidence`.

---

## Slice 1: Restock observer + belief store

Detects upward stock jumps from history and stores a per-SKU learned lead time + batch size. Pure detection logic is unit-tested; the table is RLS-verified.

### Task 1.1: `sku_reorder_belief` table + RLS

**Files:**
- Create: `supabase/migrations/20260621140000_sku_reorder_belief.sql`

**Interfaces:**
- Produces: table `public.sku_reorder_belief` with PK `(shop_id, sku_id)`, columns `lead_time_days numeric`, `batch_size int4`, `coverage_target_days numeric`, `observed_cycles int4`, `last_restock_at timestamptz`, `source text` (`'observed' | 'peer' | 'manual'`), `updated_at timestamptz`.

- [ ] **Step 1: Write the migration**

```sql
-- sku_reorder_belief: per-SKU learned supplier rhythm for agentic reorder.
-- lead_time_days / batch_size are DERIVED (restock observer), never merchant-entered.
-- source records provenance: 'peer' (cold-start prior), 'observed' (restock history),
-- 'manual' (nudged by a merchant restock, spec §3.4). RLS FORCE + shop-scoped.
create table if not exists public.sku_reorder_belief (
  shop_id uuid not null,
  sku_id uuid not null,
  lead_time_days numeric not null default 14,
  batch_size int4,
  coverage_target_days numeric not null default 14,
  observed_cycles int4 not null default 0,
  last_restock_at timestamptz,
  source text not null default 'peer' check (source in ('peer','observed','manual')),
  updated_at timestamptz not null default now(),
  primary key (shop_id, sku_id)
);

alter table public.sku_reorder_belief enable row level security;
alter table public.sku_reorder_belief force row level security;

-- Shop-scoped read; service_role (the observer/recompute) bypasses via its own grant.
create policy sku_reorder_belief_shop_read on public.sku_reorder_belief
  for select using (shop_id = (current_setting('request.jwt.claims', true)::jsonb ->> 'shop_id')::uuid);
```
(Match the exact RLS predicate used by the other Calibration tables — copy from `20260620160000_pair_calibration.sql` if it differs; consistency over the snippet above.)

- [ ] **Step 2: Apply and verify RLS**

Run (supabase MCP `apply_migration` then `get_advisors` type=security):
Expected: migration applies; `get_advisors` shows **0 RLS ERRORs** for `sku_reorder_belief`.

- [ ] **Step 3: Cross-tenant check**

```sql
-- as shop A's jwt, select shop B's rows → expect 0 rows
select count(*) from public.sku_reorder_belief where shop_id = '<shop_B_uuid>';
```
Expected: 0.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260621140000_sku_reorder_belief.sql
git commit -m "feat(reorder): sku_reorder_belief table + RLS"
```

### Task 1.2: Pure restock detection

**Files:**
- Create: `app/lib/reorder/restock.ts`
- Test: `app/lib/reorder/__tests__/restock.test.ts`

**Interfaces:**
- Consumes: stock history points `{ date: string; on_hand: number }[]` (same shape as `v_sku_inventory_history` rows; Slice 0 Step 2 confirms `available`).
- Produces:
  ```ts
  export interface RestockEvent { date: string; batchSize: number }
  export function detectRestocks(points: { date: string; on_hand: number }[], noiseFloor?: number): RestockEvent[]
  export function deriveBelief(events: RestockEvent[], points: { date: string; on_hand: number }[]):
    { leadTimeDays: number | null; batchSize: number | null; cycles: number }
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { detectRestocks, deriveBelief } from "../restock";

describe("detectRestocks", () => {
  it("flags an upward jump above the noise floor as a restock", () => {
    const points = [
      { date: "2026-05-01", on_hand: 80 },
      { date: "2026-05-10", on_hand: 8 },
      { date: "2026-05-11", on_hand: 300 }, // delivery landed
    ];
    const events = detectRestocks(points, 20);
    expect(events).toEqual([{ date: "2026-05-11", batchSize: 292 }]);
  });

  it("ignores small upward corrections below the noise floor", () => {
    const points = [
      { date: "2026-05-10", on_hand: 8 },
      { date: "2026-05-11", on_hand: 12 }, // +4, noise
    ];
    expect(detectRestocks(points, 20)).toEqual([]);
  });
});

describe("deriveBelief", () => {
  it("uses median batch size across multiple restocks (outlier-resistant)", () => {
    const events = [
      { date: "2026-04-01", batchSize: 300 },
      { date: "2026-05-01", batchSize: 300 },
      { date: "2026-06-01", batchSize: 5000 }, // one-off bulk buy
    ];
    const b = deriveBelief(events, []);
    expect(b.batchSize).toBe(300); // median, not mean → outlier ignored
    expect(b.cycles).toBe(3);
  });

  it("returns nulls when there is no restock history", () => {
    expect(deriveBelief([], [])).toEqual({ leadTimeDays: null, batchSize: null, cycles: 0 });
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run app/lib/reorder/__tests__/restock.test.ts`
Expected: FAIL ("Cannot find module '../restock'").

- [ ] **Step 3: Implement**

```ts
// Pure restock detection from stock-level history. NO I/O. A sudden upward jump
// in on-hand is a delivery landing (spec §3.1). Median (not mean) makes a one-off
// bulk buy a non-event for the learned batch size (spec §3.4 outlier guard).

export interface RestockEvent { date: string; batchSize: number }

const DEFAULT_NOISE_FLOOR = 10;

export function detectRestocks(
  points: { date: string; on_hand: number }[],
  noiseFloor: number = DEFAULT_NOISE_FLOOR,
): RestockEvent[] {
  const events: RestockEvent[] = [];
  for (let i = 1; i < points.length; i++) {
    const delta = points[i].on_hand - points[i - 1].on_hand;
    if (delta >= noiseFloor) events.push({ date: points[i].date, batchSize: delta });
  }
  return events;
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

export function deriveBelief(
  events: RestockEvent[],
  _points: { date: string; on_hand: number }[],
): { leadTimeDays: number | null; batchSize: number | null; cycles: number } {
  // Lead time derivation refined in Task 1.3 (needs the reorder-point crossing);
  // here we surface batch + cycle count from the events themselves.
  return {
    leadTimeDays: null,
    batchSize: median(events.map((e) => e.batchSize)),
    cycles: events.length,
  };
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run app/lib/reorder/__tests__/restock.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/reorder/restock.ts app/lib/reorder/__tests__/restock.test.ts
git commit -m "feat(reorder): pure restock detection + batch-size belief"
```

### Task 1.3: Lead-time derivation (gap from low-point to restock)

**Files:**
- Modify: `app/lib/reorder/restock.ts`
- Test: `app/lib/reorder/__tests__/restock.test.ts`

**Interfaces:**
- Produces: `deriveBelief` now returns a real `leadTimeDays` = median days from each restock's preceding local minimum to the restock date.

- [ ] **Step 1: Add the failing test**

```ts
it("derives lead time as days from the low point to the restock landing", () => {
  const points = [
    { date: "2026-05-01", on_hand: 80 },
    { date: "2026-05-09", on_hand: 5 },   // low point (reorder need begins)
    { date: "2026-05-23", on_hand: 300 }, // landed 14 days later
  ];
  const events = detectRestocks(points, 20);
  const b = deriveBelief(events, points);
  expect(b.leadTimeDays).toBe(14);
});
```

- [ ] **Step 2: Run, verify it fails** (`leadTimeDays` is null) — `npx vitest run app/lib/reorder/__tests__/restock.test.ts`

- [ ] **Step 3: Implement**

Replace `deriveBelief` body so that for each event it finds the minimum-on-hand point strictly before the restock date, computes day-difference (UTC), and returns the median of those gaps as `leadTimeDays`. Keep the `events.length === 0 → null` path. (Use `Date.UTC` parsing; round to whole days.)

- [ ] **Step 4: Run, verify pass** — `npx vitest run app/lib/reorder/__tests__/restock.test.ts`

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(reorder): derive lead time from low-point→restock gap"
```

### Task 1.4: Observer server module (history → belief upsert)

**Files:**
- Create: `app/lib/reorder/observer.server.ts`
- Test: `app/lib/reorder/__tests__/observer.server.test.ts`

**Interfaces:**
- Consumes: `detectRestocks`, `deriveBelief` (Task 1.2–1.3); Supabase client.
- Produces: `export async function updateReorderBeliefs(shopId: string, sb: SupabaseClient): Promise<{ updated: number }>` — reads each SKU's `v_sku_inventory_history` points (per-SKU, `.eq('shop_id').eq('sku_id')` per the view's ACCESS CONTRACT), derives belief, upserts `sku_reorder_belief` with `source='observed'` when `cycles>0`, leaving cold-start rows untouched.

- [ ] **Step 1: Write the failing test** (mock `sb` returning two SKUs and a known restock pattern; assert one `upsert` with `lead_time_days: 14, source: 'observed'`).

```ts
import { describe, it, expect, vi } from "vitest";
import { updateReorderBeliefs } from "../observer.server";
// Build a fake SupabaseClient whose .from('v_sku_inventory_history') returns the
// 3-point pattern from Task 1.3 for sku 'A', and capture .upsert payloads.
// Assert updateReorderBeliefs upserts { lead_time_days: 14, source: 'observed' } for 'A'.
```
(Write the full mock inline — do not abbreviate. Follow the mock style in `app/lib/calibration/__tests__/queue.test.ts`.)

- [ ] **Step 2: Run, verify fail** — `npx vitest run app/lib/reorder/__tests__/observer.server.test.ts`

- [ ] **Step 3: Implement** `updateReorderBeliefs`: list the shop's SKUs (`sku_dim` ids), for each fetch history points, `detectRestocks` + `deriveBelief`, and `upsert` into `sku_reorder_belief` only when `cycles>0` (else leave the peer/default row). Mark `source='observed'`, set `observed_cycles`, `last_restock_at`, `batch_size`, `lead_time_days`. Best-effort per SKU: a single SKU failure logs and continues (mirror `recompute.server.ts` non-fatal pattern).

- [ ] **Step 4: Run, verify pass** — same command.

- [ ] **Step 5: Commit**

```bash
git add app/lib/reorder/observer.server.ts app/lib/reorder/__tests__/observer.server.test.ts
git commit -m "feat(reorder): observer upserts learned belief from history"
```

---

## Slice 2: Reorder math (pure)

Computes order-by date and suggested quantity from velocity + belief. Pure, fully unit-tested, no I/O.

### Task 2.1: `reorderPlan` pure function

**Files:**
- Create: `app/lib/reorder/math.ts`
- Test: `app/lib/reorder/__tests__/math.test.ts`

**Interfaces:**
- Consumes: belief `{ leadTimeDays: number; coverageTargetDays: number; batchSize: number | null }`, live `{ onHand: number; velocityPerDay: number }`, `now: Date`.
- Produces:
  ```ts
  export interface ReorderPlan {
    needed: boolean;          // false when not yet time to order or velocity<=0
    orderByDate: string | null;   // ISO YYYY-MM-DD
    stockoutDate: string | null;
    suggestedQty: number;     // 0 when !needed
  }
  export function reorderPlan(
    belief: { leadTimeDays: number; coverageTargetDays: number; batchSize: number | null },
    live: { onHand: number; velocityPerDay: number },
    now?: Date,
  ): ReorderPlan
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { reorderPlan } from "../math";

const NOW = new Date("2026-06-01T00:00:00Z");

describe("reorderPlan", () => {
  it("flags reorder when stockout is within the supplier lead time", () => {
    // 80 on hand, 8/day → out in 10 days; lead time 21 → already past order-by.
    const p = reorderPlan(
      { leadTimeDays: 21, coverageTargetDays: 14, batchSize: null },
      { onHand: 80, velocityPerDay: 8 },
      NOW,
    );
    expect(p.needed).toBe(true);
    expect(p.stockoutDate).toBe("2026-06-11");
    expect(p.orderByDate).toBe("2026-05-21"); // stockout − 21 days
    // qty = velocity*(lead+coverage) − onHand = 8*35 − 80 = 200
    expect(p.suggestedQty).toBe(200);
  });

  it("does not flag when there is ample runway before order-by", () => {
    const p = reorderPlan(
      { leadTimeDays: 3, coverageTargetDays: 14, batchSize: null },
      { onHand: 800, velocityPerDay: 8 }, // out in 100 days
      NOW,
    );
    expect(p.needed).toBe(false);
    expect(p.suggestedQty).toBe(0);
  });

  it("returns no plan when velocity is zero (no meaningful date)", () => {
    const p = reorderPlan(
      { leadTimeDays: 21, coverageTargetDays: 14, batchSize: null },
      { onHand: 80, velocityPerDay: 0 },
      NOW,
    );
    expect(p).toEqual({ needed: false, orderByDate: null, stockoutDate: null, suggestedQty: 0 });
  });

  it("nudges suggested qty toward the learned batch size when close", () => {
    const p = reorderPlan(
      { leadTimeDays: 21, coverageTargetDays: 14, batchSize: 250 },
      { onHand: 80, velocityPerDay: 8 },
      NOW,
    );
    // raw 200, batch 250 within nudge band → round up to the merchant's habit
    expect(p.suggestedQty).toBe(250);
  });
});
```

- [ ] **Step 2: Run, verify fail** — `npx vitest run app/lib/reorder/__tests__/math.test.ts`

- [ ] **Step 3: Implement** per the formulae in spec §3.2. `velocityPerDay <= 0` → the all-null no-op object. `stockoutDate = now + ceil(onHand/velocity)`. `orderByDate = stockoutDate − leadTimeDays`. `needed = orderByDate <= now`. `suggestedQty = max(0, round(velocity*(lead+coverage) − onHand))`; if `batchSize` is within ±25% of raw qty, snap to `batchSize`. Use UTC date arithmetic, mirroring `projectedStockoutDate` in `inventory-demand.ts`.

- [ ] **Step 4: Run, verify pass** — same command.

- [ ] **Step 5: Commit**

```bash
git add app/lib/reorder/math.ts app/lib/reorder/__tests__/math.test.ts
git commit -m "feat(reorder): pure reorder math (order-by date + suggested qty)"
```

---

## Slice 3: PO draft executor + engine wiring

Turns the dead pair live: a real executor that drafts a PO (no supplier contact), plus the `HAS_EXECUTOR`/tier flip. Still queue-only after this slice (graduation lands in Slice 5).

### Task 3.1: Flip `create_po_draft` to a live, reversible pair

**Files:**
- Modify: `app/lib/calibration/confidence.ts:43-67`
- Modify: `app/lib/calibration/recompute.server.ts:29-35` (`HAS_UNDO_BRANCH`)
- Test: `app/lib/calibration/__tests__/confidence.test.ts`

**Interfaces:**
- Produces: `HAS_EXECUTOR` includes `"create_po_draft"`; `ACTION_TIER.create_po_draft = "reversible"`; `HAS_UNDO_BRANCH` includes `"create_po_draft"`.

- [ ] **Step 1: Write the failing test**

```ts
import { HAS_EXECUTOR, actionTier } from "../confidence";
it("create_po_draft is a live, reversible pair (draft is discardable)", () => {
  expect(HAS_EXECUTOR.has("create_po_draft")).toBe(true);
  expect(actionTier("create_po_draft")).toBe("reversible");
});
```

- [ ] **Step 2: Run, verify fail** — `npx vitest run app/lib/calibration/__tests__/confidence.test.ts`

- [ ] **Step 3: Implement** — add `"create_po_draft"` to `HAS_EXECUTOR` (confidence.ts:43), change `create_po_draft: "hard_to_reverse"` → `"reversible"` (confidence.ts:63), and add `"create_po_draft"` to `HAS_UNDO_BRANCH` (recompute.server.ts:29). Update the comment on confidence.ts:41-42 to note the executor is `draftPurchaseOrder` (Task 3.2), reason: Option A draft-only is reversible.

- [ ] **Step 4: Run, verify pass** — same command, plus `npx vitest run app/lib/calibration` to confirm no graduation/queue test regressed (the pair is no longer auto-excluded; update any test that asserted `conf===0` for `create_po_draft`).

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(reorder): create_po_draft is now a live reversible engine pair"
```

### Task 3.2: `draftPurchaseOrder` executor

**Files:**
- Create: `app/lib/reorder/draft.server.ts`
- Test: `app/lib/reorder/__tests__/draft.server.test.ts`

**Interfaces:**
- Consumes: `insertAuditWithIdempotency`, `priorExecutionForKey` (from `app/lib/actions/execute.server.ts`); belief + `reorderPlan`.
- Produces:
  ```ts
  export interface DraftInput {
    alertId: string | null;
    skuId: string;          // sku_dim uuid
    idempotencyKey: string;
    actor?: string;         // 'autopilot' | 'merchant'
    triggerReason?: string;
  }
  export async function draftPurchaseOrder(shopId: string, input: DraftInput, sb: SupabaseClient): Promise<ExecutedAudit>
  ```

- [ ] **Step 1: Write the failing test** — mock `sb` so the SKU has belief (lead 21, cov 14, batch 250), live on_hand 80 / velocity 8, and `cogs_fact` unit cost 1500c. Assert it inserts ONE `action_audit` row with `action_kind:'create_po_draft'`, `post_state.po.lines[0].quantity===250`, `po.lines[0].unit_cost_cents===1500`, `po.total_cents===375000`, `outcome:'succeeded'`, `pre_state:{}` (a creation has no before — matches `audit-state-diff.ts:84-93`). Also assert a replayed idempotency key returns the prior row without a second insert.

- [ ] **Step 2: Run, verify fail** — `npx vitest run app/lib/reorder/__tests__/draft.server.test.ts`

- [ ] **Step 3: Implement** `draftPurchaseOrder`:
  1. Idempotency: `priorExecutionForKey` → return prior if present.
  2. Freshness re-read (I4): read live on_hand + velocity from `v_skus_flat` for `(shopId, skuId)`; read belief from `sku_reorder_belief` (fallback defaults if no row); compute `reorderPlan`. If `!plan.needed` (e.g. restocked since the alert), insert a `succeeded` no-op audit row with `params.noop_reason:'precondition_stale'` and return (mirror the reduce-budget no-op pattern in execute.server.ts:236-268).
  3. Build PO `post_state.po = { sku_id, lines:[{ sku, quantity: plan.suggestedQty, unit_cost_cents }], total_cents, order_by_date: plan.orderByDate }`.
  4. `insertAuditWithIdempotency` with `pre_state:{}`, `actor_user_id: input.actor ?? 'merchant'`. No platform call, no supplier contact.

- [ ] **Step 4: Run, verify pass** — same command.

- [ ] **Step 5: Commit**

```bash
git add app/lib/reorder/draft.server.ts app/lib/reorder/__tests__/draft.server.test.ts
git commit -m "feat(reorder): draftPurchaseOrder executor (drafts PO, no supplier contact)"
```

### Task 3.3: Undo branch = discard draft

**Files:**
- Modify: the central `undoAction` switch (find via `grep -rn "GATEWAY_UNDO_KINDS\|function undoAction" app/lib`)
- Test: alongside the existing undo tests for that module.

**Interfaces:**
- Produces: `create_po_draft` in `GATEWAY_UNDO_KINDS`; undo writes a new `action_audit` row with `undo_of = orig.id`, `action_kind:'create_po_draft'`, `pre_state: orig.post_state` (the PO), `post_state:{ po: null, discarded: true }`, `dollar_impact_at_exec: 0` (no money moved).

- [ ] **Step 1: Write the failing test** — undo of a draft row produces a discard row with `undo_of` set and `po:null` in post_state; the original becomes undo-ineligible.

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement** the `create_po_draft` case in the undo switch: a draft discard has no platform call; it just records the reversal row (matches the `audit-state-diff.ts:84-93` "undo row carries the PO in pre_state" contract already written for this kind).

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(reorder): undo a PO draft = discard (reversible, $0 impact)"
```

---

## Slice 4: Learn from manual restocks (implicit feedback)

A merchant restock observed via the existing webhook nudges the belief (spec §3.4), weighted as a hint.

### Task 4.1: Manual-restock nudge

**Files:**
- Create: `app/lib/reorder/nudge.ts` (pure) + `app/lib/reorder/__tests__/nudge.test.ts`
- Modify: `app/routes/webhooks.inventory_levels.update.tsx` (or its server forward target) to call the nudge after recording the level change.

**Interfaces:**
- Produces:
  ```ts
  export function nudgeBelief(
    prev: { batchSize: number | null; coverageTargetDays: number; observedCycles: number },
    manualRestockSize: number,
    flaggedBeforeRestock: boolean,
  ): { batchSize: number; coverageTargetDays: number; source: "manual" }
  ```
  Rule: blend `manualRestockSize` into `batchSize` with low weight (e.g. new = round(0.7*prev + 0.3*manual)), so one outlier can't dominate; if `flaggedBeforeRestock === false` (merchant acted before the agent flagged), bump `coverageTargetDays` up by a small step (agent was too slow). `prev.batchSize == null` → seed with `manualRestockSize`.

- [ ] **Step 1: Write the failing test** (blend weight; outlier resistance; null-seed; coverage bump when not pre-flagged).

- [ ] **Step 2: Run, verify fail** — `npx vitest run app/lib/reorder/__tests__/nudge.test.ts`

- [ ] **Step 3: Implement** `nudgeBelief` (pure, per the rule above).

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Commit** — `git add ... && git commit -m "feat(reorder): pure manual-restock belief nudge"`

### Task 4.2: Wire the nudge into the inventory webhook

**Files:**
- Modify: `app/routes/webhooks.inventory_levels.update.tsx` and/or its `.server` handler.
- Test: webhook handler test (mock the level delta; assert `sku_reorder_belief` upsert with `source:'manual'` on an upward jump above the noise floor; assert NO action is auto-fired — belief-only, per spec §6 manual-move guard).

- [ ] **Step 1: Write the failing test.**
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — on an upward delta ≥ noise floor for a tracked SKU, read prev belief, `nudgeBelief`, upsert with `source:'manual'`. Idempotent on `X-Shopify-Webhook-Id` (reuse the existing dedup). Never call `draftPurchaseOrder` here.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `git commit -am "feat(reorder): manual restocks nudge belief via inventory webhook"`

---

## Slice 5: Engine integration (observer cron, alert plan, graduation, notify, dashboard)

Wires the modules into the live recompute/autopilot flow and both UI surfaces. This is the only slice that enables unattended drafting; it is gated behind every invariant.

### Task 5.1: Attach a reorder plan to `reorder_timing` alerts

**Files:**
- Modify: the engine path that writes `reorder_timing` alerts (located in Slice 0 Step 4).
- Test: the alert's `evidence` carries `{ sku_id, suggested_qty, order_by_date, stockout_date }` from `reorderPlan`.

- [ ] Steps: failing test → fail → implement (compute `reorderPlan` from belief + `v_skus_flat`, attach to `evidence`; this is what Approve/autopilot re-derive from) → pass → commit `feat(reorder): reorder_timing alert carries the draft plan`.

### Task 5.2: Run the observer in the calibration recompute cron

**Files:**
- Modify: `app/routes/cron.calibration-recompute.tsx` (call `updateReorderBeliefs(shopId, sb)` per shop before/after `recomputeShopCalibration`), or fold into the same per-shop loop.
- Test: cron loader test asserts `updateReorderBeliefs` is invoked per shop and a shop failure is non-fatal (mirrors the existing partial-error handling).

- [ ] Steps: failing test → fail → implement (per-shop call inside the existing `for` loop at recompute.tsx:23-30, collect errors the same way) → pass → commit `feat(reorder): nightly observer refresh in calibration cron`.

### Task 5.3: Approve path executes `draftPurchaseOrder`

**Files:**
- Modify: the Action Queue Approve path / `app.alerts.$id` action so that `kind === "create_po_draft"` routes to `draftPurchaseOrder` (re-deriving inputs from the trusted alert, never the form body — matches calibration design §5).
- Test: approving a queued `create_po_draft` proposal calls `draftPurchaseOrder` and bumps `alpha` via the existing approve handler.

- [ ] Steps: failing test → fail → implement → pass → commit `feat(reorder): approving a reorder proposal drafts the PO`.

### Task 5.4: Graduation + autonomous draft + notification

**Files:**
- Modify: the autopilot scorer (`runAutopilotForShop`) so a graduated `(reorder_timing, create_po_draft)` pair auto-calls `draftPurchaseOrder` with `actor:'autopilot'`, subject to the shadow gate (first 3 real instances queued), I4 freshness, and I5 idempotency `(shop, sku, day-bucket)`.
- Modify: notification path — every autonomous draft triggers a merchant notification (reuse the existing autonomous-action notification channel; calibration I7).
- Test: a graduated pair past the shadow gate auto-drafts; freshness abort path records `precondition_stale`; the same instance is never both queued and auto-fired (I5).

- [ ] Steps: failing tests → fail → implement → pass → commit `feat(reorder): autonomous PO drafting for graduated pairs + notify`.

### Task 5.5: Dashboard + embedded surfaces

**Files:**
- Embedded: the Action Queue / Agent Activity rows already render any pair generically (calibration slices 2 & 4). Verify `create_po_draft` renders with `ACTION_LABELS`/`ACTION_VERBS` ("Create PO draft" / "Created PO draft" already exist in `labels.ts:92,106`), shows suggested qty + order-by date from evidence, and the Approve button drafts.
- Dashboard: mirror — `dashboard.api.alerts.$id.action.tsx` reject/approve branch handles the kind; the Activity feed shows the draft with undo=discard. Add no new icon set; reuse existing.
- Test: a queue row for `create_po_draft` renders qty + order-by date on both surfaces; Approve drafts; Undo discards.

- [ ] Steps: failing tests → fail → implement (render the qty/date from `evidence`; PO open/download reuses the existing `app.audit.$id.po[.]pdf.tsx`) → pass → commit `feat(reorder): reorder proposals + drafts render on both surfaces`.

---

## Self-Review

**Spec coverage:** §2 engine unlock → Task 3.1. §3.1 restock observer → 1.2–1.4. §3.2 reorder math → 2.1. §3.3 cold start → covered by belief table default (lead 14 / `source:'peer'`) + math using it; peer-prior RPC enrichment reuses the existing `action_pair_prior` mechanism (no new task — it's already wired in recompute). §3.4 manual feedback → Slice 4. §4 executor → 3.2 + undo 3.3. §5 data flow → 5.1–5.4. §6 invariants → 3.2 (I4/I5), 5.4 (I3/I5), 4.2 (manual-move guard). §7 open decisions → resolved: storage = new table (1.1), notification = reuse existing (5.4), noise floor = `detectRestocks` param (1.2, tune in 4.2), coverage default = belief column default (1.1). §8 dashboard parity → 5.5. §9 testing → every task is TDD. §10 build order → slices match.

**Placeholder scan:** Slices 1–3 carry complete code. Slices 4–5 task steps reference exact files/functions verified by reading; Tasks 5.1/5.3/5.4 use the compressed "Steps:" form because they wire into engine paths whose exact internals are pinned by Slice 0 Step 4 discovery — the implementer must read the located path before writing, which the discovery task enforces. This is intentional (those internals are owned by the in-flight calibration engine work), not a placeholder.

**Type consistency:** `ReorderPlan`/`reorderPlan` (2.1) consumed by `draftPurchaseOrder` (3.2) and alert evidence (5.1). `detectRestocks`/`deriveBelief` (1.2–1.3) consumed by `updateReorderBeliefs` (1.4). `nudgeBelief` (4.1) consumed by the webhook (4.2). `HAS_EXECUTOR`/`actionTier` names match `confidence.ts` as read. `insertAuditWithIdempotency`/`priorExecutionForKey`/`ExecutedAudit` match `execute.server.ts` as read.

---

## Coordination note

The Calibration engine (slices 0–5) is actively being developed in parallel. Slices 1–4 here are self-contained and safe to build independently. **Slice 5 touches engine-owned paths** (autopilot scorer, alert writer, approve handler) — coordinate with whoever owns that work before merging, or land Slices 1–4 first and treat Slice 5 as a follow-up once the engine surfaces stabilize.
