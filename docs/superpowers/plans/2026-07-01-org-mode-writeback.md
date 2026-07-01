# Org-mode + Write-back Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each store an `org_mode` cutover state machine and route the two store-mutating autopilot writers (price, inventory) to Calderyn's own tables (only at `live`) vs the Shopify Admin API (all other modes), defaulting every existing shop to `mirror` so shipping this slice changes no live behavior.

**Architecture:** A `shops.org_mode` column (`mirror | importing | dual_run | live`, default `mirror`) plus an append-only `cutover_transition` audit table. A new `app/lib/cutover/org-mode.server.ts` holds the pure state machine + `writesToOwned(mode)` router predicate (true only for `live`) and the DB read/transition functions, mirroring the `transitionOrder` discipline (audit row inserted before the UPDATE, compare-and-set on the from-mode, throw on illegal move / 0-row update). The two executors (`adjust-price.server.ts`, `inventory-relocate.server.ts`) branch their terminal write on `writesToOwned`: at `live` they call new owned-write primitives in `app/lib/actions/owned-writes.server.ts` (price → `variant_dim.retail_price_cents`; inventory → the Slice-2 inventory engine); otherwise the existing Shopify path runs unchanged.

**Tech Stack:** TypeScript (strict), Remix, Supabase (service-role client via `getSupabase`), Vitest with in-memory Supabase stubs, raw Supabase SQL migrations (not Prisma).

## Global Constraints

- **Binary routing (locked):** `writesToOwned(mode)` is `true` **only for `live`**. `mirror`/`importing`/`dual_run` all keep writing to Shopify. No dual-write in this slice.
- **Default `mirror`, zero live change:** the migration defaults every existing shop to `mirror`; nothing in this slice transitions a shop.
- **State machine enforced like the order spine** (`app/lib/order/order.server.ts` + `app/lib/order/state.ts`): legal transitions only, exactly one append-only audit row per transition inserted **before** the `shops` UPDATE, compare-and-set on the from-mode (`.eq("org_mode", from)`), throw on illegal transition or 0-row update — never a silent no-op (rule 12).
- **Legal transitions:** `mirror→importing`; `importing→{dual_run, mirror}`; `dual_run→{live, mirror}`; `live→dual_run`. Identity moves are NOT legal. Everything else throws.
- **Repo invariant:** `sku_dim.id == variant_dim.id`, so an alert's SKU id IS the owned variant id.
- **Migration numbering:** `supabase/migrations/20260701130000_org_mode.sql` (sequences after `20260701120000_variant_shipping.sql`, the latest on `origin/main`). Applying to prod Supabase is a controller step AFTER the gate is green — not part of any task's commit.
- **`cutover_transition` RLS:** service-role only — enable RLS, revoke from anon/authenticated, **no `current_shop_id()` policy** (matches `raw_owned_event` / the ledger tables; the resulting INFO `rls_enabled_no_policy` advisor is expected).
- **TS only, no `any`** without written justification (an in-memory Supabase test stub may `eslint-disable @typescript-eslint/no-explicit-any` with the existing header comment, matching `fake-supabase.ts`).
- **Lint gotcha:** do NOT use `let x: typeof import("../mod").x` in tests (`@typescript-eslint/consistent-type-imports` fails `--max-warnings=0`). Use `import type * as Mod from "../mod"` then `typeof Mod.x`.
- **Dashboard parity:** exempt for this slice (no merchant-facing surface).
- **Server-only:** `org-mode.server.ts` and `owned-writes.server.ts` must never be imported from a client module (`.server.ts` suffix enforces this).

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20260701130000_org_mode.sql` (create) | `shops.org_mode` column + `cutover_transition` audit table |
| `app/lib/cutover/org-mode.server.ts` (create) | `OrgMode` type; `ORG_MODES`; `LEGAL_ORG_TRANSITIONS`; `isOrgMode`; `isLegalOrgTransition`; `assertLegalOrgTransition`; `writesToOwned`; `getOrgMode`; `transitionOrgMode`; `CutoverTransition` type |
| `app/lib/cutover/__tests__/org-mode.server.test.ts` (create) | Unit tests for the module (pure helpers + DB fns via stub) |
| `app/lib/catalog/catalog.server.ts` (modify) | Add `setVariantPrice(shopId, variantId, priceCents)` — owned single-variant price write + sku_dim reprojection |
| `app/lib/catalog/__tests__/catalog-set-price.server.test.ts` (create) | Unit test for `setVariantPrice` |
| `app/lib/actions/owned-writes.server.ts` (create) | `getOwnedVariantPricing`; `setOwnedVariantPrice`; `applyOwnedInventoryMove` — owned store-action primitives |
| `app/lib/actions/__tests__/owned-writes.server.test.ts` (create) | Unit tests for the owned primitives |
| `app/lib/actions/adjust-price.server.ts` (modify) | Branch terminal write on `writesToOwned`; owned resolve + owned price write; shared guardrail cap |
| `app/lib/actions/__tests__/adjust-price-action.test.ts` (modify) | Add `mirror`/`live` routing tests |
| `app/lib/actions/inventory-relocate.server.ts` (modify) | Branch terminal write on `writesToOwned`; owned inventory move |
| `app/lib/actions/__tests__/inventory-relocate.test.ts` (modify) | Add `mirror`/`live` routing tests |

---

## Task 1: Migration — `shops.org_mode` + `cutover_transition`

**Files:**
- Create: `supabase/migrations/20260701130000_org_mode.sql`

**Interfaces:**
- Consumes: existing `public.shops(id uuid)` table.
- Produces: `shops.org_mode text not null default 'mirror'` (check-constrained to the four modes); `public.cutover_transition(id, shop_id, from_mode, to_mode, reason, occurred_at)` audit table. These are the storage the mode module (Task 2) reads/writes.

- [ ] **Step 1: Write the migration SQL**

Create `supabase/migrations/20260701130000_org_mode.sql`:

```sql
-- org_mode: per-store cutover state machine + append-only transition audit.
-- shops.org_mode routes the store-mutating autopilot writers (price, inventory)
-- to Calderyn's own tables (only at `live`) vs the Shopify Admin API (every other
-- mode). Defaults to `mirror` so every existing shop keeps writing to Shopify and
-- this migration changes no live behavior until a shop is deliberately moved.
--
-- cutover_transition follows the service-role-only RLS pattern of the owned
-- intake/ledger tables (20260630170000_owned_event_ingest.sql): RLS enabled,
-- grants revoked, and NO current_shop_id() policy -- it is reached only via the
-- BYPASSRLS service-role client, so the INFO rls_enabled_no_policy advisor is
-- expected and intentional.

alter table public.shops
  add column if not exists org_mode text not null default 'mirror'
  check (org_mode in ('mirror', 'importing', 'dual_run', 'live'));

create table if not exists public.cutover_transition (
  id          uuid        primary key default gen_random_uuid(),
  shop_id     uuid        not null references public.shops(id) on delete cascade,
  from_mode   text        not null,
  to_mode     text        not null,
  reason      text,
  occurred_at timestamptz not null default now()
);

create index if not exists cutover_transition_shop_idx
  on public.cutover_transition(shop_id);

alter table public.cutover_transition enable row level security;
revoke all on table public.cutover_transition from anon, authenticated;
```

- [ ] **Step 2: Sanity-check the SQL**

Run: `grep -c "org_mode" supabase/migrations/20260701130000_org_mode.sql`
Expected: `>= 2` (the column add + the check constraint reference).

Confirm by eye: check constraint lists exactly the four modes; default is `'mirror'`; the table has RLS enabled + grants revoked + no `create policy` line; filename timestamp is newer than `20260701120000`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260701130000_org_mode.sql
git commit -m "feat(cutover): org_mode column + cutover_transition audit table (Step 9 slice 1)"
```

---

## Task 2: `org-mode.server.ts` — state machine + DB read/transition

**Files:**
- Create: `app/lib/cutover/org-mode.server.ts`
- Test: `app/lib/cutover/__tests__/org-mode.server.test.ts`

**Interfaces:**
- Consumes: `getSupabase` from `~/lib/supabase.server`; `shops.org_mode` + `cutover_transition` (Task 1).
- Produces (used by Tasks 4 & 5):
  - `type OrgMode = "mirror" | "importing" | "dual_run" | "live"`
  - `writesToOwned(mode: OrgMode): boolean` — true only for `live`
  - `getOrgMode(shopId: string): Promise<OrgMode>` — defaults to `mirror` when the stored value is null; throws if the shop is absent or the value is an unknown mode
  - `transitionOrgMode(shopId: string, to: OrgMode, reason?: string): Promise<CutoverTransition>`
  - `type CutoverTransition = { id; shopId; fromMode; toMode; reason: string | null; occurredAt }`

- [ ] **Step 1: Write the failing test**

Create `app/lib/cutover/__tests__/org-mode.server.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";

// getSupabase is replaced per-test via this holder so each test supplies its own stub.
let currentSb: unknown = null;
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => currentSb }));

import {
  ORG_MODES,
  writesToOwned,
  isLegalOrgTransition,
  assertLegalOrgTransition,
  getOrgMode,
  transitionOrgMode,
  type OrgMode,
} from "../org-mode.server";

/**
 * Purpose-built Supabase stub. `from("shops")` serves the initial
 * select().eq().maybeSingle() read AND the update().eq().eq().select() write;
 * it distinguishes them by whether update() was called on that builder.
 * `from("cutover_transition")` serves insert().select().single().
 */
function makeSb(opts: {
  shopFound?: boolean;
  shopMode?: string | null;
  updateRows?: Array<{ id: string }>;
  transitionRow?: Record<string, unknown>;
  onInsert?: (row: unknown) => void;
  onUpdate?: (set: unknown) => void;
}) {
  const builder = () => {
    let isUpdate = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test stub
    const b: any = {
      select: () => b,
      eq: () => b,
      update: (set: unknown) => {
        isUpdate = true;
        opts.onUpdate?.(set);
        return b;
      },
      insert: (row: unknown) => {
        opts.onInsert?.(row);
        return b;
      },
      maybeSingle: async () => ({
        data: opts.shopFound === false ? null : { org_mode: opts.shopMode ?? null },
        error: null,
      }),
      single: async () => ({ data: opts.transitionRow ?? { id: "t1" }, error: null }),
      then: (res: (r: { data: unknown; error: null }) => unknown) =>
        res({ data: isUpdate ? (opts.updateRows ?? [{ id: "shop-1" }]) : [], error: null }),
    };
    return b;
  };
  return { from: () => builder() };
}

describe("writesToOwned", () => {
  it("is true only for live", () => {
    expect(writesToOwned("live")).toBe(true);
    for (const m of ORG_MODES.filter((x) => x !== "live")) {
      expect(writesToOwned(m as OrgMode)).toBe(false);
    }
  });
});

describe("legal transitions", () => {
  it("accepts the legal edges and rejects the rest", () => {
    expect(isLegalOrgTransition("mirror", "importing")).toBe(true);
    expect(isLegalOrgTransition("importing", "dual_run")).toBe(true);
    expect(isLegalOrgTransition("importing", "mirror")).toBe(true);
    expect(isLegalOrgTransition("dual_run", "live")).toBe(true);
    expect(isLegalOrgTransition("dual_run", "mirror")).toBe(true);
    expect(isLegalOrgTransition("live", "dual_run")).toBe(true);
    // illegal
    expect(isLegalOrgTransition("mirror", "live")).toBe(false);
    expect(isLegalOrgTransition("mirror", "mirror")).toBe(false); // identity not legal
    expect(isLegalOrgTransition("live", "mirror")).toBe(false);
  });

  it("assertLegalOrgTransition throws on an illegal move", () => {
    expect(() => assertLegalOrgTransition("mirror", "live")).toThrow();
    expect(() => assertLegalOrgTransition("mirror", "importing")).not.toThrow();
  });
});

describe("getOrgMode", () => {
  it("returns the stored mode", async () => {
    currentSb = makeSb({ shopMode: "live" });
    expect(await getOrgMode("shop-1")).toBe("live");
  });

  it("defaults to mirror when the stored value is null", async () => {
    currentSb = makeSb({ shopMode: null });
    expect(await getOrgMode("shop-1")).toBe("mirror");
  });

  it("throws when the shop is absent", async () => {
    currentSb = makeSb({ shopFound: false });
    await expect(getOrgMode("nope")).rejects.toThrow(/not found/);
  });

  it("throws on an unknown stored mode", async () => {
    currentSb = makeSb({ shopMode: "bogus" });
    await expect(getOrgMode("shop-1")).rejects.toThrow(/unknown org_mode/);
  });
});

describe("transitionOrgMode", () => {
  it("legal transition writes exactly one audit row BEFORE updating shops", async () => {
    let insertedRow: Record<string, unknown> | null = null;
    let updatedSet: Record<string, unknown> | null = null;
    currentSb = makeSb({
      shopMode: "mirror",
      updateRows: [{ id: "shop-1" }],
      transitionRow: {
        id: "t1",
        shop_id: "shop-1",
        from_mode: "mirror",
        to_mode: "importing",
        reason: "kickoff",
        occurred_at: "2026-07-01T00:00:00Z",
      },
      onInsert: (r) => (insertedRow = r as Record<string, unknown>),
      onUpdate: (s) => (updatedSet = s as Record<string, unknown>),
    });

    const t = await transitionOrgMode("shop-1", "importing", "kickoff");

    expect(insertedRow).toMatchObject({
      shop_id: "shop-1",
      from_mode: "mirror",
      to_mode: "importing",
      reason: "kickoff",
    });
    expect(updatedSet).toEqual({ org_mode: "importing" });
    expect(t).toMatchObject({ fromMode: "mirror", toMode: "importing", reason: "kickoff" });
  });

  it("throws on an illegal transition and writes nothing", async () => {
    let inserted = false;
    let updated = false;
    currentSb = makeSb({
      shopMode: "mirror",
      onInsert: () => (inserted = true),
      onUpdate: () => (updated = true),
    });
    await expect(transitionOrgMode("shop-1", "live")).rejects.toThrow();
    expect(inserted).toBe(false);
    expect(updated).toBe(false);
  });

  it("throws when the compare-and-set updates 0 rows (concurrent change)", async () => {
    currentSb = makeSb({ shopMode: "dual_run", updateRows: [] });
    await expect(transitionOrgMode("shop-1", "live")).rejects.toThrow(/expected exactly 1|0 rows/);
  });

  it("throws when the shop is absent and writes nothing", async () => {
    let inserted = false;
    currentSb = makeSb({ shopFound: false, onInsert: () => (inserted = true) });
    await expect(transitionOrgMode("nope", "importing")).rejects.toThrow(/not found/);
    expect(inserted).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/cutover/__tests__/org-mode.server.test.ts`
Expected: FAIL — cannot find module `../org-mode.server`.

- [ ] **Step 3: Write the implementation**

Create `app/lib/cutover/org-mode.server.ts`:

```ts
// Cutover org_mode state machine + DB enforcer (platform pivot Step 9). Server-only:
// reaches Postgres through the service-role client (getSupabase, BYPASSRLS), threading
// shop_id explicitly on every read/write. Mirrors the order spine (order.server.ts +
// state.ts): the legal-transition set is the single source of truth, transitionOrgMode
// inserts one append-only cutover_transition audit row BEFORE the shops UPDATE, and the
// UPDATE is a compare-and-set on the from-mode so a concurrent transition can't be
// silently overwritten. writesToOwned is the router predicate the store executors branch
// on: only `live` routes autopilot writes to Calderyn's own tables.

import { getSupabase } from "~/lib/supabase.server";

export const ORG_MODES = ["mirror", "importing", "dual_run", "live"] as const;
export type OrgMode = (typeof ORG_MODES)[number];

export interface CutoverTransition {
  id: string;
  shopId: string;
  fromMode: OrgMode;
  toMode: OrgMode;
  reason: string | null;
  occurredAt: string;
}

// Adjacency list of LEGAL transitions. Anything not listed is illegal — including
// identity moves and any jump (mirror->live). Keyed exhaustively over OrgMode so a
// new mode forces a decision here (TS Record completeness).
//   mirror    -> importing
//   importing -> dual_run, mirror   (abort back to mirror)
//   dual_run  -> live,     mirror   (rollback)
//   live      -> dual_run           (emergency rollback off owned writes)
export const LEGAL_ORG_TRANSITIONS: Record<OrgMode, readonly OrgMode[]> = {
  mirror: ["importing"],
  importing: ["dual_run", "mirror"],
  dual_run: ["live", "mirror"],
  live: ["dual_run"],
};

export function isOrgMode(value: string): value is OrgMode {
  return (ORG_MODES as readonly string[]).includes(value);
}

/** True iff `from -> to` is a legal transition. Identity moves are NOT legal. */
export function isLegalOrgTransition(from: OrgMode, to: OrgMode): boolean {
  return LEGAL_ORG_TRANSITIONS[from].includes(to);
}

/**
 * Throw a visible error (rule 12) unless `from -> to` is legal, after validating both
 * modes are in the known vocabulary. Guards every transition so an illegal move fails
 * loudly rather than silently no-ops.
 */
export function assertLegalOrgTransition(from: string, to: string): asserts to is OrgMode {
  if (!isOrgMode(from)) throw new Error(`unknown current org_mode: ${from}`);
  if (!isOrgMode(to)) throw new Error(`unknown target org_mode: ${to}`);
  if (!isLegalOrgTransition(from, to)) {
    const allowed = LEGAL_ORG_TRANSITIONS[from];
    const allowedText = allowed.length ? allowed.join(", ") : "(none — terminal state)";
    throw new Error(`illegal org_mode transition ${from} -> ${to}; allowed from ${from}: ${allowedText}`);
  }
}

/**
 * Router predicate: only `live` routes the store-mutating autopilot writers to Calderyn's
 * own tables. mirror/importing/dual_run all keep writing to Shopify (binary routing; the
 * dual_run parity dual-write is a later Step-9 slice).
 */
export function writesToOwned(mode: OrgMode): boolean {
  return mode === "live";
}

/** Read a shop's current mode. Defaults to `mirror` when the column is null; throws if the
 *  shop is absent or holds an unknown mode (never guess at the routing target). */
export async function getOrgMode(shopId: string): Promise<OrgMode> {
  if (!shopId) throw new Error("shopId is required");
  const sb = getSupabase();
  const { data, error } = await sb.from("shops").select("org_mode").eq("id", shopId).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`shop ${shopId} not found`);
  const raw = (data as Record<string, unknown>).org_mode;
  const mode = raw == null ? "mirror" : String(raw);
  if (!isOrgMode(mode)) throw new Error(`unknown org_mode ${mode} for shop ${shopId}`);
  return mode;
}

/**
 * Move a shop to `to`, enforcing the legal-transition machine and writing exactly one
 * append-only cutover_transition row. Fails visibly (rule 12): throws if the shop is
 * absent (never creates one), throws on an illegal transition WITHOUT writing anything,
 * and throws if the compare-and-set updates 0 rows (the shop changed under us — never a
 * silent no-op). The audit row is inserted BEFORE the shops UPDATE so a successful
 * transition can never lack its audit row. Exact discipline of transitionOrder.
 */
export async function transitionOrgMode(
  shopId: string,
  to: OrgMode,
  reason?: string,
): Promise<CutoverTransition> {
  if (!shopId) throw new Error("shopId is required");

  const sb = getSupabase();
  const current = await sb.from("shops").select("org_mode").eq("id", shopId).maybeSingle();
  if (current.error) throw current.error;
  if (!current.data) throw new Error(`shop ${shopId} not found`);

  const rawFrom = (current.data as Record<string, unknown>).org_mode;
  const from = rawFrom == null ? "mirror" : String(rawFrom);
  // Throws on an illegal/unknown transition before any write (rule 12).
  assertLegalOrgTransition(from, to);

  const inserted = await sb
    .from("cutover_transition")
    .insert({ shop_id: shopId, from_mode: from, to_mode: to, reason: reason ?? null })
    .select("id, shop_id, from_mode, to_mode, reason, occurred_at")
    .single();
  if (inserted.error) throw inserted.error;
  if (!inserted.data) throw new Error("cutover_transition insert returned no row");

  // Compare-and-set on the from-mode: the UPDATE applies ONLY if the shop is still in
  // `from`. A 0-row result means a concurrent transition moved it under us — throw rather
  // than report a success on a no-op (rule 12).
  const updated = await sb
    .from("shops")
    .update({ org_mode: to })
    .eq("id", shopId)
    .eq("org_mode", from)
    .select("id");
  if (updated.error) throw updated.error;
  const affected = (updated.data as unknown[] | null)?.length ?? 0;
  if (affected !== 1) {
    throw new Error(
      `transitionOrgMode updated ${affected} rows for shop ${shopId}; expected exactly 1 — the shop changed under us`,
    );
  }

  return mapTransition(inserted.data as Record<string, unknown>);
}

function mapTransition(row: Record<string, unknown>): CutoverTransition {
  return {
    id: String(row.id),
    shopId: String(row.shop_id),
    fromMode: String(row.from_mode) as OrgMode,
    toMode: String(row.to_mode) as OrgMode,
    reason: row.reason == null ? null : String(row.reason),
    occurredAt: String(row.occurred_at),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/cutover/__tests__/org-mode.server.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add app/lib/cutover/org-mode.server.ts app/lib/cutover/__tests__/org-mode.server.test.ts
git commit -m "feat(cutover): org_mode state machine + writesToOwned router (Step 9 slice 1)"
```

---

## Task 3: Owned-write primitives

**Files:**
- Modify: `app/lib/catalog/catalog.server.ts` (append `setVariantPrice`)
- Test: `app/lib/catalog/__tests__/catalog-set-price.server.test.ts` (create)
- Create: `app/lib/actions/owned-writes.server.ts`
- Test: `app/lib/actions/__tests__/owned-writes.server.test.ts` (create)

**Interfaces:**
- Consumes: `getSupabase` (`~/lib/supabase.server`); `projectProductToSkuDim` (already imported in `catalog.server.ts`); `createTransfer` from `../inventory/engine.server`.
- Produces (used by Tasks 4 & 5):
  - `catalog.server.ts`: `setVariantPrice(shopId, variantId, priceCents): Promise<{ priorPriceCents: number | null }>`
  - `owned-writes.server.ts`:
    - `getOwnedVariantPricing(shopId, skuCode): Promise<{ variantId: string; currentPriceCents: number } | null>` — null when the SKU isn't owned or has no price
    - `setOwnedVariantPrice(shopId, variantId, priceCents): Promise<{ priorPriceCents: number | null }>`
    - `applyOwnedInventoryMove(opts: { shopId; variantId; fromLocationId; toLocationId; quantity }): Promise<{ transferId: string }>`

- [ ] **Step 1: Write the catalog `setVariantPrice` test**

Create `app/lib/catalog/__tests__/catalog-set-price.server.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const project = vi.fn().mockResolvedValue(undefined);
vi.mock("../project-sku-dim.server", () => ({ projectProductToSkuDim: project }));

const maybeSingle = vi
  .fn()
  .mockResolvedValue({ data: { product_id: "p1", retail_price_cents: 1999 }, error: null });
const update = vi.fn(() => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }));
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle }) }) }), update }),
  }),
}));

beforeEach(() => {
  project.mockClear();
});

describe("setVariantPrice", () => {
  it("writes the new price, returns the prior, and re-projects to sku_dim", async () => {
    const { setVariantPrice } = await import("../catalog.server");
    const r = await setVariantPrice("shop1", "v1", 2499);
    expect(r).toEqual({ priorPriceCents: 1999 });
    expect(project).toHaveBeenCalledWith("p1");
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ retail_price_cents: 2499 }));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/lib/catalog/__tests__/catalog-set-price.server.test.ts`
Expected: FAIL — `setVariantPrice` is not exported from `../catalog.server`.

- [ ] **Step 3: Append `setVariantPrice` to `catalog.server.ts`**

At the end of `app/lib/catalog/catalog.server.ts`, add (confirm `projectProductToSkuDim` is already imported at the top — it is used elsewhere in this file):

```ts
/**
 * Owned single-variant price write: set variant_dim.retail_price_cents by owned variant id
 * (shop-scoped ownership guard on the WHERE) and re-project the parent product to sku_dim so
 * the storefront + engine reads see the new price. Returns the prior price (cents) for undo.
 */
export async function setVariantPrice(
  shopId: string,
  variantId: string,
  priceCents: number,
): Promise<{ priorPriceCents: number | null }> {
  const sb = getSupabase();
  const { data: v, error } = await sb
    .from("variant_dim")
    .select("product_id, retail_price_cents")
    .eq("shop_id", shopId)
    .eq("id", variantId)
    .maybeSingle();
  if (error) throw error;
  if (!v) throw new Error(`variant ${variantId} not found for shop`);
  const priorPriceCents = v.retail_price_cents == null ? null : Number(v.retail_price_cents);

  const { error: upErr } = await sb
    .from("variant_dim")
    .update({ retail_price_cents: priceCents, updated_at: new Date().toISOString() })
    .eq("shop_id", shopId)
    .eq("id", variantId);
  if (upErr) throw upErr;

  await projectProductToSkuDim(String(v.product_id));
  return { priorPriceCents };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run app/lib/catalog/__tests__/catalog-set-price.server.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the owned-writes test**

Create `app/lib/actions/__tests__/owned-writes.server.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const setVariantPrice = vi.fn();
vi.mock("../../catalog/catalog.server", () => ({
  setVariantPrice: (...a: unknown[]) => setVariantPrice(...a),
}));

const createTransfer = vi.fn();
vi.mock("../../inventory/engine.server", () => ({
  createTransfer: (...a: unknown[]) => createTransfer(...a),
}));

// getOwnedVariantPricing reads sku_dim + variant_dim through getSupabase.
let skuRow: Record<string, unknown> | null;
let variantRow: Record<string, unknown> | null;
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: (table: string) => {
      const row = table === "sku_dim" ? skuRow : variantRow;
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.maybeSingle = async () => ({ data: row, error: null });
      return chain;
    },
  }),
}));

import {
  getOwnedVariantPricing,
  setOwnedVariantPrice,
  applyOwnedInventoryMove,
} from "../owned-writes.server";

beforeEach(() => {
  vi.clearAllMocks();
  skuRow = { id: "v1" };
  variantRow = { retail_price_cents: 1500 };
});

describe("getOwnedVariantPricing", () => {
  it("resolves the owned variant id + current price for an owned SKU", async () => {
    const r = await getOwnedVariantPricing("shop-1", "SKU-A");
    expect(r).toEqual({ variantId: "v1", currentPriceCents: 1500 });
  });

  it("returns null when the SKU is not owned", async () => {
    skuRow = null;
    expect(await getOwnedVariantPricing("shop-1", "SKU-A")).toBeNull();
  });

  it("returns null when the owned variant has no price", async () => {
    variantRow = { retail_price_cents: null };
    expect(await getOwnedVariantPricing("shop-1", "SKU-A")).toBeNull();
  });
});

describe("setOwnedVariantPrice", () => {
  it("delegates to catalog.setVariantPrice", async () => {
    setVariantPrice.mockResolvedValue({ priorPriceCents: 1500 });
    const r = await setOwnedVariantPrice("shop-1", "v1", 1700);
    expect(setVariantPrice).toHaveBeenCalledWith("shop-1", "v1", 1700);
    expect(r).toEqual({ priorPriceCents: 1500 });
  });
});

describe("applyOwnedInventoryMove", () => {
  it("delegates to the inventory engine as an instant transfer", async () => {
    createTransfer.mockResolvedValue({ transferId: "tr-1" });
    const r = await applyOwnedInventoryMove({
      shopId: "shop-1",
      variantId: "v1",
      fromLocationId: "loc-a",
      toLocationId: "loc-b",
      quantity: 40,
    });
    expect(createTransfer).toHaveBeenCalledWith("shop-1", "v1", "loc-a", "loc-b", 40, "instant");
    expect(r).toEqual({ transferId: "tr-1" });
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run app/lib/actions/__tests__/owned-writes.server.test.ts`
Expected: FAIL — cannot find module `../owned-writes.server`.

- [ ] **Step 7: Write `owned-writes.server.ts`**

Create `app/lib/actions/owned-writes.server.ts`:

```ts
// Owned store-action primitives (platform pivot Step 9). When a shop is at org_mode=live,
// the store executors route their terminal write here instead of the Shopify Admin API:
//   - price  -> variant_dim.retail_price_cents (via catalog.setVariantPrice, which also
//               re-projects sku_dim so storefront/engine reads see the new price)
//   - stock  -> the Slice-2 inventory engine (an atomic, cannot-oversell transfer)
// getOwnedVariantPricing resolves the owned variant id + current owned price for a SKU code,
// the owned analogue of reading the live Shopify price (anchors the guardrail cap on the
// owned branch — the routing changes the WRITE target, not the safety envelope).

import { getSupabase } from "~/lib/supabase.server";
import { setVariantPrice } from "../catalog/catalog.server";
import { createTransfer } from "../inventory/engine.server";

/** Resolve a SKU code to its owned variant id + current retail price (cents), shop-scoped.
 *  Returns null when the SKU isn't owned by this shop or has no owned price to adjust. */
export async function getOwnedVariantPricing(
  shopId: string,
  skuCode: string,
): Promise<{ variantId: string; currentPriceCents: number } | null> {
  const sb = getSupabase();
  const { data: sku, error: sErr } = await sb
    .from("sku_dim")
    .select("id")
    .eq("shop_id", shopId)
    .eq("sku", skuCode)
    .maybeSingle();
  if (sErr) throw sErr;
  if (!sku?.id) return null;
  const variantId = String(sku.id);

  // sku_dim.id == variant_dim.id (repo invariant); the retail price lives on variant_dim.
  const { data: v, error: vErr } = await sb
    .from("variant_dim")
    .select("retail_price_cents")
    .eq("shop_id", shopId)
    .eq("id", variantId)
    .maybeSingle();
  if (vErr) throw vErr;
  if (v?.retail_price_cents == null) return null;
  return { variantId, currentPriceCents: Number(v.retail_price_cents) };
}

/** Owned price write. Delegates to the catalog primitive (update + sku_dim reprojection). */
export async function setOwnedVariantPrice(
  shopId: string,
  variantId: string,
  priceCents: number,
): Promise<{ priorPriceCents: number | null }> {
  return setVariantPrice(shopId, variantId, priceCents);
}

/** Owned inventory move: an instant location->location transfer through the atomic
 *  (cannot-oversell) inventory engine. Keyed by owned variant id + owned location ids. */
export async function applyOwnedInventoryMove(opts: {
  shopId: string;
  variantId: string;
  fromLocationId: string;
  toLocationId: string;
  quantity: number;
}): Promise<{ transferId: string }> {
  return createTransfer(
    opts.shopId,
    opts.variantId,
    opts.fromLocationId,
    opts.toLocationId,
    opts.quantity,
    "instant",
  );
}
```

- [ ] **Step 8: Run both tests to verify they pass**

Run: `npx vitest run app/lib/catalog/__tests__/catalog-set-price.server.test.ts app/lib/actions/__tests__/owned-writes.server.test.ts`
Expected: PASS.

- [ ] **Step 9: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 10: Commit**

```bash
git add app/lib/catalog/catalog.server.ts app/lib/catalog/__tests__/catalog-set-price.server.test.ts app/lib/actions/owned-writes.server.ts app/lib/actions/__tests__/owned-writes.server.test.ts
git commit -m "feat(cutover): owned-write primitives (variant price + inventory move) (Step 9 slice 1)"
```

---

## Task 4: Route the price executor on `writesToOwned`

**Files:**
- Modify: `app/lib/actions/adjust-price.server.ts`
- Test: `app/lib/actions/__tests__/adjust-price-action.test.ts`

**Interfaces:**
- Consumes: `getOrgMode`, `writesToOwned` (Task 2); `getOwnedVariantPricing`, `setOwnedVariantPrice` (Task 3).
- Produces: no new exports. At `mirror` the existing Shopify path runs byte-for-byte; at `live` the owned resolve + owned price write run, the Shopify Admin client is untouched, and the guardrail cap still applies (anchored on the owned current price).

- [ ] **Step 1: Write the failing routing tests**

Add to `app/lib/actions/__tests__/adjust-price-action.test.ts`. First, add mocks near the other `vi.mock` calls at the top:

```ts
const getOrgMode = vi.fn();
vi.mock("../../cutover/org-mode.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../cutover/org-mode.server")>()),
  getOrgMode: (...a: never[]) => getOrgMode(...a),
}));

const getOwnedVariantPricing = vi.fn();
const setOwnedVariantPrice = vi.fn();
vi.mock("../owned-writes.server", () => ({
  getOwnedVariantPricing: (...a: never[]) => getOwnedVariantPricing(...a),
  setOwnedVariantPrice: (...a: never[]) => setOwnedVariantPrice(...a),
}));
```

In the existing `beforeEach`, add defaults so every current test keeps taking the Shopify branch:

```ts
    getOrgMode.mockResolvedValue("mirror");
    getOwnedVariantPricing.mockResolvedValue({ variantId: "sku-1", currentPriceCents: 1500 });
    setOwnedVariantPrice.mockResolvedValue({ priorPriceCents: 1500 });
```

Then add a new `describe` block (keep it inside the file, after the existing suite or nested — use the shared `alert`, `client`, `sb`, `okSb`, `base`, `ADMIN`, `VARIANT`, `PRODUCT` helpers):

```ts
describe("executeAdjustPriceAlertAction — org_mode routing", () => {
  const base = {
    shopId: "shop-1",
    alertId: "a1",
    kind: "adjust_price" as const,
    idempotencyKey: "idem-1",
  };
  const okSb = () => sb({ id: "sku-1", external_id: VARIANT });

  it("mirror: writes to Shopify, never the owned column", async () => {
    getOrgMode.mockResolvedValue("mirror");
    await executeAdjustPriceAlertAction({
      ...base,
      client: client(alert({})) as never,
      admin: ADMIN,
      sb: okSb(),
    });
    expect(setVariantPrice).toHaveBeenCalled(); // Shopify write
    expect(setOwnedVariantPrice).not.toHaveBeenCalled();
  });

  it("live: writes the owned column, never Shopify, cap anchored on owned price", async () => {
    getOrgMode.mockResolvedValue("live");
    getOwnedVariantPricing.mockResolvedValue({ variantId: "sku-1", currentPriceCents: 1500 });
    const c = client(alert({}));
    const res = await executeAdjustPriceAlertAction({
      ...base,
      client: c as never,
      admin: ADMIN,
      sb: okSb(),
    });
    // Restored price = COGS $8 + baseline margin $9 = $17 on the owned variant id.
    expect(setOwnedVariantPrice).toHaveBeenCalledWith("shop-1", "sku-1", 1700);
    expect(setVariantPrice).not.toHaveBeenCalled(); // Shopify untouched
    expect(readVariantPrice).not.toHaveBeenCalled();
    expect(c.actions.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          variant_id: "sku-1",
          prior_price_cents: 1500,
          new_price_cents: 1700,
        }),
      }),
    );
    expect(res.outcome).toBe("succeeded");
  });

  it("live: rejects a merchant override beyond the ±cap of the owned price (422)", async () => {
    getOrgMode.mockResolvedValue("live");
    getOwnedVariantPricing.mockResolvedValue({ variantId: "sku-1", currentPriceCents: 1500 });
    await expect(
      executeAdjustPriceAlertAction({
        ...base,
        client: client(alert({})) as never,
        admin: ADMIN,
        sb: okSb(),
        newPriceCents: 2000, // > +15% of $15.00
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect(setOwnedVariantPrice).not.toHaveBeenCalled();
  });

  it("live: rejects when the SKU has no owned price (422)", async () => {
    getOrgMode.mockResolvedValue("live");
    getOwnedVariantPricing.mockResolvedValue(null);
    await expect(
      executeAdjustPriceAlertAction({
        ...base,
        client: client(alert({})) as never,
        admin: ADMIN,
        sb: okSb(),
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect(setOwnedVariantPrice).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/lib/actions/__tests__/adjust-price-action.test.ts`
Expected: FAIL — the `live` tests fail (executor doesn't branch yet; it still calls Shopify), and `getOrgMode`/owned mocks are unused by the implementation.

- [ ] **Step 3: Refactor the executor to branch on `writesToOwned`**

In `app/lib/actions/adjust-price.server.ts`:

Add imports near the top (after the existing imports):

```ts
import { getOrgMode, writesToOwned } from "../cutover/org-mode.server";
import { getOwnedVariantPricing, setOwnedVariantPrice } from "./owned-writes.server";
```

Replace the block that resolves the target and reads the current price (the section from `const target = await resolveSkuVariant(...)` through the end of the `readVariantPrice` try/catch that sets `current`) with a mode-aware resolve. Concretely, replace:

```ts
  const target = await resolveSkuVariant(sb, shopId, alert.sku);
  if (!target) {
    throw new CalderynError({
      code: "sku_not_found",
      status: 422,
      message: "This SKU has no linked Shopify variant, so its price can't be changed here.",
    });
  }

  // Read the live current price (anchors both the suggestion and the cap). A
  // read failure must not proceed blind.
  let current: { priceCents: number; productGid: string };
  try {
    current = await readVariantPrice(admin, target.variantGid);
  } catch (err) {
    throw new CalderynError({
      code: "action_failed",
      status: 502,
      message: err instanceof Error ? err.message : "Couldn't read the current Shopify price.",
    });
  }
```

with:

```ts
  // Route the price write by the shop's cutover mode: at `live` the target price lives in
  // the owned catalog (no Shopify variant needed); every other mode reads + writes Shopify
  // exactly as before. The guardrail cap is anchored on whichever current price we read, so
  // the safety envelope is identical on both branches — only the WRITE target changes.
  const owned = writesToOwned(await getOrgMode(shopId));

  // `current.priceCents` anchors the suggestion + cap; `ownedVariantId` / `shopifyTarget`
  // carry the write handle for the branch we're on.
  let current: { priceCents: number };
  let ownedVariantId: string | null = null;
  let shopifyTarget: { variantGid: string; productGid: string } | null = null;

  if (owned) {
    const priced = await getOwnedVariantPricing(shopId, alert.sku);
    if (!priced) {
      throw new CalderynError({
        code: "sku_not_found",
        status: 422,
        message: "This SKU has no owned price to change.",
      });
    }
    ownedVariantId = priced.variantId;
    current = { priceCents: priced.currentPriceCents };
  } else {
    const target = await resolveSkuVariant(sb, shopId, alert.sku);
    if (!target) {
      throw new CalderynError({
        code: "sku_not_found",
        status: 422,
        message: "This SKU has no linked Shopify variant, so its price can't be changed here.",
      });
    }
    // Read the live current price (anchors both the suggestion and the cap). A read
    // failure must not proceed blind.
    let live: { priceCents: number; productGid: string };
    try {
      live = await readVariantPrice(admin, target.variantGid);
    } catch (err) {
      throw new CalderynError({
        code: "action_failed",
        status: 502,
        message: err instanceof Error ? err.message : "Couldn't read the current Shopify price.",
      });
    }
    current = { priceCents: live.priceCents };
    shopifyTarget = { variantGid: target.variantGid, productGid: live.productGid };
  }
```

The shared cap/suggestion block (everything from `const capPct = ...` through computing `finalPriceCents` / `capped`) is unchanged — it already reads only `current.priceCents`, `currentCogsCents`, and `capPct`.

Then replace the Shopify write + audit block. Replace:

```ts
  // Apply the price on Shopify. A failure throws — the audit row below is only
  // written on success (rule 12: no "succeeded" row for an unchanged price).
  let applied: { priceCents: number };
  try {
    applied = await setVariantPrice(admin, {
      productGid: current.productGid,
      variantId: target.variantGid,
      newPriceCents: finalPriceCents,
    });
  } catch (err) {
    throw new CalderynError({
      code: "action_failed",
      status: 502,
      message: err instanceof Error ? err.message : "Shopify price update failed.",
    });
  }

  // ONE audit row. params carries what undo needs: variant + product to target,
  // prior_price_cents to restore.
  const params: Record<string, unknown> = {
    target: alert.sku,
    sku: alert.sku,
    sku_id: target.skuId,
    variant_id: target.variantGid,
    product_id: current.productGid,
    prior_price_cents: current.priceCents,
    new_price_cents: applied.priceCents,
    capped,
    estimate_cents: alert.dollar_impact,
  };
```

with:

```ts
  // Apply the price on the routed target. A failure throws — the audit row below is only
  // written on success (rule 12: no "succeeded" row for an unchanged price).
  let appliedPriceCents: number;
  const params: Record<string, unknown> = {
    target: alert.sku,
    sku: alert.sku,
    prior_price_cents: current.priceCents,
    capped,
    estimate_cents: alert.dollar_impact,
  };

  if (owned && ownedVariantId) {
    try {
      await setOwnedVariantPrice(shopId, ownedVariantId, finalPriceCents);
    } catch (err) {
      throw new CalderynError({
        code: "action_failed",
        status: 502,
        message: err instanceof Error ? err.message : "Owned price update failed.",
      });
    }
    appliedPriceCents = finalPriceCents;
    // undo of an owned price change is a later Step-9 slice; record the ids it will need.
    params.sku_id = ownedVariantId;
    params.variant_id = ownedVariantId;
    params.new_price_cents = appliedPriceCents;
  } else if (shopifyTarget) {
    let applied: { priceCents: number };
    try {
      applied = await setVariantPrice(admin, {
        productGid: shopifyTarget.productGid,
        variantId: shopifyTarget.variantGid,
        newPriceCents: finalPriceCents,
      });
    } catch (err) {
      throw new CalderynError({
        code: "action_failed",
        status: 502,
        message: err instanceof Error ? err.message : "Shopify price update failed.",
      });
    }
    appliedPriceCents = applied.priceCents;
    params.variant_id = shopifyTarget.variantGid;
    params.product_id = shopifyTarget.productGid;
    params.new_price_cents = appliedPriceCents;
  } else {
    // Unreachable: exactly one of the two branches resolves a write handle above.
    throw new CalderynError({ code: "action_failed", status: 500, message: "No price write target resolved." });
  }
```

Note: the existing `resolveSkuVariant` returns `{ skuId, variantGid }`, so the Shopify branch no longer references `target.skuId` in params — the Shopify path historically set `sku_id: target.skuId` (the internal sku id). Preserve it: in the Shopify branch, `resolveSkuVariant` still runs, so capture `sku_id` there. Adjust the Shopify branch to also set `params.sku_id = target.skuId;` — do this by hoisting the resolved `target` into a variable accessible at write time. To keep the diff simple, in the `else` (Shopify resolve) branch above, after `shopifyTarget = {...}`, also set a `let shopifySkuId = target.skuId;` at executor scope and assign `params.sku_id = shopifySkuId;` in the Shopify write branch.

**Concretely:** declare `let shopifySkuId: string | null = null;` alongside `shopifyTarget`, set it in the Shopify resolve branch (`shopifySkuId = target.skuId;`), and in the Shopify write branch add `params.sku_id = shopifySkuId;`.

- [ ] **Step 4: Run the full price test file**

Run: `npx vitest run app/lib/actions/__tests__/adjust-price-action.test.ts`
Expected: PASS — all pre-existing Shopify tests still green (they run at `mirror`) plus the four new routing tests.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add app/lib/actions/adjust-price.server.ts app/lib/actions/__tests__/adjust-price-action.test.ts
git commit -m "feat(cutover): route adjust_price to owned catalog at org_mode=live (Step 9 slice 1)"
```

---

## Task 5: Route the inventory executor on `writesToOwned`

**Files:**
- Modify: `app/lib/actions/inventory-relocate.server.ts`
- Test: `app/lib/actions/__tests__/inventory-relocate.test.ts`

**Interfaces:**
- Consumes: `getOrgMode`, `writesToOwned` (Task 2); `applyOwnedInventoryMove` (Task 3). The executor already resolves owned location ids (`from.id`, `to.id`) and the owned variant id (`input.skuId` == `sku_dim.id`).
- Produces: no new exports. At `mirror` the existing `inventoryAdjustQuantitiesForShop` path runs; at `live` the owned inventory engine runs and the Shopify Admin client is untouched. Validation (quantity, same-location, ownership, availability) stays shared on both branches, and the audit row is written identically (`operationId` = the owned transfer id at `live`).

- [ ] **Step 1: Write the failing routing tests**

Add to `app/lib/actions/__tests__/inventory-relocate.test.ts`. Add mocks near the other `vi.mock` calls:

```ts
const getOrgMode = vi.fn();
vi.mock("../../cutover/org-mode.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../cutover/org-mode.server")>()),
  getOrgMode: (...a: unknown[]) => getOrgMode(...a),
}));

const applyOwnedInventoryMove = vi.fn();
vi.mock("../owned-writes.server", () => ({
  applyOwnedInventoryMove: (...a: unknown[]) => applyOwnedInventoryMove(...a),
}));
```

In the existing `beforeEach`, add:

```ts
  getOrgMode.mockResolvedValue("mirror");
  applyOwnedInventoryMove.mockResolvedValue({ transferId: "tr-1" });
```

Add a new `describe` block using the file's existing `SHOP`, `INPUT`, `ADMIN`, `mockSb`, and the module-level `skuRow`/`locRows`/`invRow` seeded in `beforeEach`:

```ts
describe("executeInventoryRelocation — org_mode routing", () => {
  it("mirror: moves stock via Shopify, never the owned engine", async () => {
    getOrgMode.mockResolvedValue("mirror");
    const res = await executeInventoryRelocation(SHOP, INPUT, mockSb(), ADMIN);
    expect(res.outcome).toBe("succeeded");
    expect(inventoryAdjustQuantities).toHaveBeenCalled(); // Shopify path (underlying)
    expect(applyOwnedInventoryMove).not.toHaveBeenCalled();
  });

  it("live: moves stock via the owned engine, never Shopify", async () => {
    getOrgMode.mockResolvedValue("live");
    const res = await executeInventoryRelocation(SHOP, INPUT, mockSb(), ADMIN);
    expect(res.outcome).toBe("succeeded");
    // owned engine keyed by owned variant id (input.skuId) + owned location ids (loc-a/loc-b).
    expect(applyOwnedInventoryMove).toHaveBeenCalledWith({
      shopId: SHOP,
      variantId: "sku-1",
      fromLocationId: "loc-a",
      toLocationId: "loc-b",
      quantity: 40,
    });
    expect(inventoryAdjustQuantities).not.toHaveBeenCalled();
    const [, , audit] = insertAuditWithIdempotency.mock.calls[0];
    expect(audit.params.shopify_operation_id).toBe("tr-1"); // owned transfer id in the operation slot
  });

  it("live: records a FAILED audit row when the owned engine rejects (insufficient stock)", async () => {
    getOrgMode.mockResolvedValue("live");
    applyOwnedInventoryMove.mockRejectedValue(new Error("insufficient_stock"));
    const res = await executeInventoryRelocation(SHOP, INPUT, mockSb(), ADMIN);
    expect(res.outcome).toBe("failed");
    const [, , audit] = insertAuditWithIdempotency.mock.calls[0];
    expect(audit.outcome).toBe("failed");
    expect(audit.last_error).toContain("insufficient_stock");
    expect(audit.post_state).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/lib/actions/__tests__/inventory-relocate.test.ts`
Expected: FAIL — the `live` tests fail (executor doesn't branch yet).

- [ ] **Step 3: Branch the executor's terminal write**

In `app/lib/actions/inventory-relocate.server.ts`:

Add imports near the top:

```ts
import { getOrgMode, writesToOwned } from "../cutover/org-mode.server";
import { applyOwnedInventoryMove } from "./owned-writes.server";
```

Replace the Shopify-mutation block (step 6, `try { ({ operationId } = await inventoryAdjustQuantitiesForShop(...)); } catch ...`) with a mode-aware branch. Replace:

```ts
  // 6. Execute the Shopify mutation. Failure is recorded visibly (rule 12).
  let outcome: ExecutedAudit["outcome"] = "succeeded";
  let lastError: string | null = null;
  let operationId: string | null = null;
  try {
    ({ operationId } = await inventoryAdjustQuantitiesForShop(shopId, admin, {
      inventoryItemId: inventoryItemId,
      fromLocationId: input.fromLocationId,
      toLocationId: input.toLocationId,
      delta: input.quantity,
    }, sb));
  } catch (err) {
    outcome = "failed";
    lastError = err instanceof Error ? err.message : String(err);
  }
```

with:

```ts
  // 6. Execute the move on the routed target. At org_mode=live the move lands in the owned
  // inventory engine (atomic, cannot-oversell) keyed by owned variant + owned location ids;
  // every other mode adjusts Shopify exactly as before. A failure on either branch is
  // recorded visibly as a failed audit row (rule 12), never a fake success.
  const owned = writesToOwned(await getOrgMode(shopId));
  let outcome: ExecutedAudit["outcome"] = "succeeded";
  let lastError: string | null = null;
  let operationId: string | null = null;
  try {
    if (owned) {
      const { transferId } = await applyOwnedInventoryMove({
        shopId,
        variantId: input.skuId,
        fromLocationId: from.id,
        toLocationId: to.id,
        quantity: input.quantity,
      });
      operationId = transferId;
    } else {
      ({ operationId } = await inventoryAdjustQuantitiesForShop(shopId, admin, {
        inventoryItemId: inventoryItemId,
        fromLocationId: input.fromLocationId,
        toLocationId: input.toLocationId,
        delta: input.quantity,
      }, sb));
    }
  } catch (err) {
    outcome = "failed";
    lastError = err instanceof Error ? err.message : String(err);
  }
```

The audit block (step 7) is unchanged — `operationId` already flows into `params.shopify_operation_id`, which now carries the owned transfer id at `live`.

- [ ] **Step 4: Run the full inventory test file**

Run: `npx vitest run app/lib/actions/__tests__/inventory-relocate.test.ts`
Expected: PASS — all pre-existing tests (they run at `mirror`) plus the three new routing tests.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add app/lib/actions/inventory-relocate.server.ts app/lib/actions/__tests__/inventory-relocate.test.ts
git commit -m "feat(cutover): route inventory relocation to owned engine at org_mode=live (Step 9 slice 1)"
```

---

## Final gate (after all tasks, before PR)

Run the CLAUDE.md pre-commit gate from the worktree and paste evidence:

- [ ] `npx vitest run app/lib/cutover app/lib/actions app/lib/catalog` — all green (touched suites).
- [ ] `npm run typecheck` — exit 0.
- [ ] `npm run lint -- --max-warnings=0` on touched files — exit 0 (watch the `consistent-type-imports` gotcha).
- [ ] `npm run build` — exit 0 (runs `verify-client-bundle`).
- [ ] `/code-review` on the working tree — resolve blockers.
- [ ] Full suite sanity: `npx vitest run` — note the one known pre-existing failure (`app/lib/social/__tests__/linkedin-connection.test.ts`) is unrelated (test-pollution/env; passes in isolation).

Migration apply (controller step, AFTER gate green): `mcp__supabase__apply_migration` on project `ajgrmnvzxfxxlwrxcgnu` with the Task 1 SQL; verify `shops.org_mode` + `cutover_transition` exist and `get_advisors` shows only the expected INFO `rls_enabled_no_policy`.

---

## Self-Review (against the spec)

- **Spec §Scope "org_mode column + cutover_transition"** → Task 1. ✔
- **"org-mode.server.ts: read, transition, writesToOwned"** → Task 2 (getOrgMode / transitionOrgMode / writesToOwned). ✔
- **"Route adjust-price + inventory-relocate on writesToOwned"** → Tasks 4 & 5. ✔
- **Decision 1 binary routing (live only)** → `writesToOwned` returns `mode === "live"` (Task 2), tested. ✔
- **Decision 2 default mirror, zero live change** → migration default (Task 1); every existing executor test runs at `mirror` and stays green (Tasks 4 & 5). ✔
- **Decision 3 state machine like transitionOrder** → audit-before-update + compare-and-set + throw (Task 2), tested for legal/illegal/0-row/absent. ✔
- **Invariant 1 default mirror → Shopify path unchanged** → Task 4/5 `mirror` tests assert the owned branch is NOT taken. ✔
- **Invariant 2 live → owned tables** → Task 4/5 `live` tests assert owned write + admin untouched. ✔
- **Invariant 3 legal transitions only** → Task 2 illegal-transition test. ✔
- **Invariant 4 audit + compare-and-set** → Task 2 legal + 0-row tests. ✔
- **Invariant 5 owned price bounded like Shopify** → Task 4 `live` ±cap-reject test; shared cap block anchored on `current.priceCents`. ✔
- **Owned-write helpers module** → Task 3 (`owned-writes.server.ts`). ✔
- **Out-of-scope items** (parity gate, go-live gate, merchant UI, dual-write, promote, other actions) → none added. ✔
- **Dashboard parity exempt** → no merchant surface touched. ✔

**Placeholder scan:** none — every code step shows full code. **Type consistency:** `writesToOwned`/`getOrgMode`/`getOwnedVariantPricing`/`setOwnedVariantPrice`/`applyOwnedInventoryMove` signatures are identical across their defining task and their consuming tasks.
```

