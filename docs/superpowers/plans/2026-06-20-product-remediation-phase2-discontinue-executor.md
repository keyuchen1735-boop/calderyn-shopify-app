# Product-Economics Remediation — Phase 2: `discontinue_sku` Executor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Phase-1 advisory **discontinue** move into a real, one-click executable on both Fix-it surfaces. `discontinue_sku` sets an internal `do_not_reorder` flag on the SKU's product (which shows on Inventory and **blocks** `create_po_draft`), archives/unpublishes the product on live Shopify via `productUpdate`, and is fully reversible by a one-click **undo** (re-publish + clear the flag). Everything flows through the existing action/audit/undo infrastructure: one append-only `action_audit` row, idempotency dedup, acknowledge-on-success, and the per-action guardrail dollar cap.

**Architecture:** A new alert/SKU-scoped executor `executeDiscontinueAlertAction` modeled exactly on `executeInventoryAlertAction` (`app/lib/actions/alert-action.server.ts`): load alert → reject if not `open` (409) → gate on `DETECTOR_TO_ACTIONS` (403) → guardrail dollar cap (403) → derive the target product GID **from the alert's SKU record** (never the request body) → set the `do_not_reorder` flag → call Shopify `productUpdate` (archive + unpublish) → write ONE audit row via `insertAuditWithIdempotency` (recording `pre_state` so undo can reverse) → `acknowledgeAlert`. Undo routes through the existing generic `undo.server.ts` by adding a `discontinue_sku` branch: re-publish/activate the product on Shopify and clear the flag from the recorded `pre_state`. The same `MoveKind`/`StrategicMove.executor` engine from Phase 1 is widened to emit `discontinue_sku`, so the deterministic ranking and both panels stay the single source of truth.

**Tech Stack:** TypeScript (strict, ESM), Vitest, Remix loaders/actions, Supabase (read + write here), Shopify Admin GraphQL (`productUpdate`, `publishablePublish`/`publishableUnpublish`), React + bespoke `cd-*` CSS (dashboard) / Shopify Polaris (embedded app).

---

## Scope & deliberate simplifications (read first)

Phase 2 is the second vertical slice of the 4-phase spec (`docs/superpowers/specs/2026-06-20-product-economics-remediation-design.md`). It depends on **Phase 1 having landed** (`app/lib/remediation/{types,rank,synopsis}.ts`, the `attachRemediation` seam in `app/lib/calderyn.server.ts`, the `remediation` field on `Alert`/`AlertVM`, and both Fix-it panels rendering ranked advisory moves with Snooze as the only button). This plan assumes that baseline. Deliberate trims vs the spec, all deferred (rule 12 — stated, not hidden):

- **No autopilot wiring.** Autopilot auto-selecting and executing `discontinue_sku` within caps is **Phase 4**. Phase 2 only adds the manual one-click path on both surfaces. The executor is autopilot-ready (it takes an `actor`/`triggerReason`), but no candidate-allow-list or `autopilot.server.ts` change happens here.
- **No `reallocate_spend_sku` / Meta budget shift.** That is **Phase 3**. The `cut_ads` and `reallocate_to_winner` moves stay advisory in Phase 2.
- **Archive, not delete.** `discontinue_sku` ARCHIVES + UNPUBLISHES the product (Shopify `ProductStatus.ARCHIVED` + unpublish from all channels). It never deletes — deletion is irreversible and would break the undo guarantee. The internal `do_not_reorder` flag is the durable signal; Shopify archive is the customer-facing effect.
- **No `remediation jsonb` column / no caching.** Phase 1 computes the plan on read in `attachRemediation`; Phase 2 keeps that. Persisting the plan + AI prose is Phase 4.
- **Undo window = the existing 24h window** in `undo.server.ts` (`UNDO_WINDOW_MS`). No new window; `discontinue_sku` undo obeys the same boundary as inventory/campaign undos.

Detectors that may offer `discontinue_sku`: the **structurally-dead** product-economics detectors — `negative_unit_economics`, `margin_erosion`, `cogs_drift`, `return_rate_hidden_loss`, and `ad_tax_overload` (the last two only when `structurallyDead` is true; the engine already gates this — see Phase 1 `rank.ts`). Per `DETECTOR_TO_ACTIONS` we add `discontinue_sku` to all five so the gateway's `allowed.includes(kind)` check passes whenever the engine recommends it. The engine (`rankMoves`) — not `DETECTOR_TO_ACTIONS` — decides *whether* the button appears; the map only authorizes it.

## File structure

| File | Responsibility | Task |
|---|---|---|
| `app/lib/types.ts` | Add `discontinue_sku` to `ActionKind` | 1 |
| `app/lib/labels.ts` | `ACTION_LABELS` / `ACTION_VERBS` entries; add `discontinue_sku` to `DETECTOR_TO_ACTIONS` for the 5 product-econ detectors | 1 |
| `app/lib/remediation/types.ts` | Widen `StrategicMove.executor` to include `"discontinue_sku"` (keep union open) | 2 |
| `app/lib/remediation/rank.ts` | Set `executor: "discontinue_sku"` on the `discontinue` move | 2 |
| `app/lib/remediation/__tests__/rank.test.ts` | Assert the discontinue move carries the executor | 2 |
| `supabase/migrations/20260620120000_sku_dim_do_not_reorder.sql` | `do_not_reorder boolean not null default false` on `sku_dim` | 3 |
| `tests/engine/schema/migrations/20260620120000_sku_dim_do_not_reorder.sql` | Test-schema mirror of the column | 3 |
| `supabase/migrations/20260620120500_v_skus_flat_do_not_reorder.sql` | Re-create `v_skus_flat` projecting `do_not_reorder` + `product_id` | 4 |
| `app/lib/shopify/product.server.ts` | `discontinueProduct` / `restoreProduct` (archive+unpublish / activate+publish) via Admin GraphQL | 5 |
| `app/lib/shopify/__tests__/product.test.ts` | Mock-admin tests for both mutations | 5 |
| `app/lib/actions/discontinue.server.ts` | `setDoNotReorder(sb, shopId, skuId, value)` + product-GID resolver | 6 |
| `app/lib/actions/__tests__/discontinue-flag.test.ts` | Flag write + resolver tests | 6 |
| `app/lib/actions/alert-action.server.ts` | New `executeDiscontinueAlertAction`; widen `InventoryAlertActionKind` is NOT reused — add a parallel gateway | 7 |
| `app/lib/actions/__tests__/discontinue-action.test.ts` | Gateway tests (happy path, 409, 403, missing GID, guardrail) | 7 |
| `app/lib/actions/undo.server.ts` | `discontinue_sku` undo branch (restore + clear flag) | 8 |
| `app/lib/actions/__tests__/undo-discontinue.test.ts` | Undo reverses archive + clears flag | 8 |
| `app/routes/dashboard.api.alerts.$id.action.tsx` | Add `discontinue_sku` to `KINDS`; route to the discontinue gateway | 9 |
| `app/routes/app.alerts.$id.tsx` | Embedded action handler: execute `discontinue_sku`; gate `create_po_draft` on the flag; render the button | 10, 11 |
| `app/components/dashboard/DashboardApp.tsx` | `executeAction` branch for `discontinue_sku` (live endpoint) | 12 |
| `app/components/dashboard/screens/Alerts.tsx` | Render `discontinue` move as a real button (`executor !== null`) | 12 |
| `app/components/dashboard/screens/Inventory.tsx` | Show a "Won't reorder" pill when `do_not_reorder` | 13 |
| `app/components/dashboard/view-models.ts` + `app/lib/calderyn.server.ts` | Carry `do_not_reorder` onto the `SKU`/`SkuVM` DTO | 13 |
| `docs/superpowers/HANDOFF-*` / App Store note | `write_products` scope + review note | 14 |

---

## Task 1: Add the `discontinue_sku` action kind + authorize it

**Files:**
- Modify: `app/lib/types.ts` (the `ActionKind` union, lines 7–18)
- Modify: `app/lib/labels.ts` (`ACTION_LABELS` ~42–54, `ACTION_VERBS` ~56–68, `DETECTOR_TO_ACTIONS` ~304–319)

- [ ] **Step 1: Add `discontinue_sku` to `ActionKind`**

In `app/lib/types.ts`, extend the `ActionKind` union (insert before `"snooze_alert"`):

```typescript
export type ActionKind =
  | "pause_campaign"
  | "resume_campaign"
  | "reduce_campaign_budget"
  | "increase_campaign_budget"
  | "reallocate_budget"
  | "exclude_geo"
  | "reallocate_inventory"
  | "create_po_draft"
  | "raise_free_ship_threshold"
  | "exclude_sku_free_ship"
  | "discontinue_sku"
  | "snooze_alert";
```

- [ ] **Step 2: Add labels/verbs and authorize the kind per detector**

In `app/lib/labels.ts`, add to `ACTION_LABELS` (before `snooze_alert`):

```typescript
  discontinue_sku: "Stop reordering & archive product",
```

Add to `ACTION_VERBS` (before `snooze_alert`):

```typescript
  discontinue_sku: "Discontinued product",
```

Then add `"discontinue_sku"` to `DETECTOR_TO_ACTIONS` for the five product-economics detectors (place it before `"snooze_alert"` in each list). The map becomes (only these five lines change):

```typescript
  ad_tax_overload: ["reallocate_budget", "reduce_campaign_budget", "pause_campaign", "discontinue_sku", "snooze_alert"],
  margin_erosion: ["discontinue_sku", "snooze_alert"],
  negative_unit_economics: ["pause_campaign", "reduce_campaign_budget", "discontinue_sku", "snooze_alert"],
  cogs_drift: ["discontinue_sku", "snooze_alert"],
  return_rate_hidden_loss: ["pause_campaign", "reduce_campaign_budget", "discontinue_sku", "snooze_alert"],
```

- [ ] **Step 3: Typecheck (every `Record<ActionKind, …>` must now cover `discontinue_sku`)**

Run: `npx tsc --noEmit`
Expected: exit 0. If it fails, it will be on a `Record<ActionKind, ...>` literal missing the key (e.g. an icon map or `recoveredCentsForAction` switch). Add the missing entry there — do NOT cast or widen to silence it (rule 12). Likely spots: `app/components/dashboard/format.ts` (`ACTION_LABELS` mirror, if any), `app/lib/audit-impact.ts`, `app/components/dashboard/icons.tsx` (`CD_ACTION_ICON`). Resolve each in its own follow-up step within this task.

- [ ] **Step 4: Add the dashboard icon (CLAUDE.md icon rule — Lucide via `CD_ICONS`)**

Run: `grep -n "CD_ACTION_ICON\|archive\|ban\|\"box\"" app/components/dashboard/icons.tsx`
Then add to `CD_ACTION_ICON` an entry `discontinue_sku: "archive"`. If `"archive"` is not already registered in `CD_ICONS`, add it: `import { Archive } from "lucide-react";` and one line `archive: Archive,` in `CD_ICONS`. Do not hand-draw SVGs or use another icon set.

- [ ] **Step 5: Commit**

```bash
git add app/lib/types.ts app/lib/labels.ts app/components/dashboard/icons.tsx
git commit -m "actions: add discontinue_sku kind, labels, and detector authorization"
```

---

## Task 2: Widen the remediation engine to emit the `discontinue_sku` executor

The Phase-1 engine sets `executor: null` on every move except `snooze`. Phase 2 makes the `discontinue` move carry a live executor so the panels render it as a button.

**Files:**
- Modify: `app/lib/remediation/types.ts` (`StrategicMove.executor`, line 25)
- Modify: `app/lib/remediation/rank.ts` (the `move()` helper, lines 76–83)
- Modify: `app/lib/remediation/__tests__/rank.test.ts` (append)

- [ ] **Step 1: Write a failing test for the executor on the discontinue move**

Append to `app/lib/remediation/__tests__/rank.test.ts`:

```typescript
describe("rankMoves — executors (Phase 2)", () => {
  it("the discontinue move carries the discontinue_sku executor", () => {
    const plan = rankMoves(
      input({
        detectorId: "negative_unit_economics",
        evidence: { gross_unit_margin_usd: -4, cac_per_unit_usd: 30, net_per_unit_usd: -34 },
      }),
    );
    const discontinue = plan.moves.find((m) => m.kind === "discontinue")!;
    expect(discontinue).toBeDefined();
    expect(discontinue.executor).toBe("discontinue_sku");
  });

  it("non-discontinue moves stay advisory (executor null), snooze stays snooze_alert", () => {
    const plan = rankMoves(
      input({
        detectorId: "negative_unit_economics",
        evidence: { gross_unit_margin_usd: 23, cac_per_unit_usd: 170, net_per_unit_usd: -147 },
      }),
    );
    const cut = plan.moves.find((m) => m.kind === "cut_ads")!;
    const realloc = plan.moves.find((m) => m.kind === "reallocate_to_winner")!;
    const snooze = plan.moves.find((m) => m.kind === "snooze")!;
    expect(cut.executor).toBeNull();
    expect(realloc.executor).toBeNull();
    expect(snooze.executor).toBe("snooze_alert");
  });
});
```

- [ ] **Step 2: Run the tests to verify the first one fails**

Run: `npx vitest run app/lib/remediation/__tests__/rank.test.ts`
Expected: FAIL — `discontinue.executor` is `null`, not `"discontinue_sku"`.

- [ ] **Step 3: Widen the executor union**

In `app/lib/remediation/types.ts`, change the `executor` field on `StrategicMove`. Keep the union open/extensible (Phase 3 adds `reallocate_spend_sku`):

```typescript
  /** Live executor for this move, or null when the move is advisory only.
   *  Phase 1: only "snooze" → "snooze_alert". Phase 2 adds "discontinue_sku" on
   *  the discontinue move. Phase 3 will add the Meta budget-shift executor; keep
   *  this union open so later phases extend it without breaking existing values. */
  executor: "snooze_alert" | "discontinue_sku" | null;
```

- [ ] **Step 4: Set the executor on the discontinue move**

In `app/lib/remediation/rank.ts`, change the `move()` helper so the `discontinue` kind maps to its executor (the existing `kind === "snooze"` branch stays):

```typescript
function move(kind: MoveKind, dollarImpactCents: number): StrategicMove {
  return {
    kind,
    dollarImpactCents,
    executor:
      kind === "snooze"
        ? "snooze_alert"
        : kind === "discontinue"
          ? "discontinue_sku"
          : null,
    label: MOVE_LABELS[kind],
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run app/lib/remediation/__tests__/rank.test.ts`
Expected: PASS (all prior tests + the 2 new ones). The Phase-1 test that asserted "snooze is the ONLY executable move" must be UPDATED — find it (it filters `m.executor !== null` and expects `["snooze"]`) and change its expectation to include `discontinue` when the input is structurally dead. If that test only feeds a viable (`+$23`) input, it still passes (no discontinue move present); verify which input it uses before editing. Do not delete the test.

- [ ] **Step 6: Typecheck + commit**

```bash
npx tsc --noEmit
git add app/lib/remediation/types.ts app/lib/remediation/rank.ts app/lib/remediation/__tests__/rank.test.ts
git commit -m "remediation: emit discontinue_sku executor on the discontinue move"
```

---

## Task 3: `do_not_reorder` column on `sku_dim`

**Files:**
- Create: `supabase/migrations/20260620120000_sku_dim_do_not_reorder.sql`
- Create: `tests/engine/schema/migrations/20260620120000_sku_dim_do_not_reorder.sql` (test-schema mirror — the test harness applies these)

- [ ] **Step 1: Write the migration**

```sql
-- app/discontinue_sku (Phase 2): an internal "do not reorder" flag on the SKU's
-- product. Set when a merchant (or, later, autopilot) discontinues a SKU; it
-- surfaces on the Inventory surface and BLOCKS create_po_draft so a discontinued
-- product can never be re-ordered. Cleared by the discontinue_sku undo. Idempotent
-- (if not exists) so it composes with the test-schema mirror. RLS unchanged — the
-- added column inherits sku_dim's existing read/write policy.
alter table public.sku_dim
  add column if not exists do_not_reorder boolean not null default false;

create index if not exists sku_dim_do_not_reorder_idx
  on public.sku_dim (shop_id) where do_not_reorder = true;
```

- [ ] **Step 2: Mirror it into the test schema**

Create `tests/engine/schema/migrations/20260620120000_sku_dim_do_not_reorder.sql` with the **same** `alter table` statement (the index is optional in the test schema but harmless — include it for parity):

```sql
-- Test-schema mirror of the production sku_dim.do_not_reorder column (Phase 2).
alter table public.sku_dim
  add column if not exists do_not_reorder boolean not null default false;

create index if not exists sku_dim_do_not_reorder_idx
  on public.sku_dim (shop_id) where do_not_reorder = true;
```

- [ ] **Step 3: Validate the migration diff (per CLAUDE.md pre-commit gate)**

Run: `npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script` is NOT applicable here (this repo uses Supabase SQL migrations, not Prisma schema for these tables). Instead validate SQL parses and the column lands:

Run: `grep -rn "do_not_reorder" supabase/migrations/ tests/engine/schema/migrations/`
Expected: shows the column in both files. (No live DB apply in this plan; the dashboard backend owns `sku_dim` ingestion via `mapVariantToSku`, which writes `product_id`/`inventory_item_id`; this migration only adds the flag column the executor toggles.)

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260620120000_sku_dim_do_not_reorder.sql tests/engine/schema/migrations/20260620120000_sku_dim_do_not_reorder.sql
git commit -m "supabase: add sku_dim.do_not_reorder flag (discontinue_sku)"
```

---

## Task 4: Expose `do_not_reorder` + `product_id` on `v_skus_flat`

The Inventory surface reads SKUs via `v_skus_flat` (final SELECT in `…_v_skus_flat_ship_pnl_real_cost_only.sql`). Re-create the view adding the two columns. Re-create rather than `alter` — Postgres views can't add columns in place.

**Files:**
- Create: `supabase/migrations/20260620120500_v_skus_flat_do_not_reorder.sql`

- [ ] **Step 1: Read the current view definition to copy it verbatim**

Run: `cat supabase/migrations/20260616150000_v_skus_flat_ship_pnl_real_cost_only.sql`
Confirm the final SELECT projects `sk.id, sk.shop_id, sk.title, sk.sku, on_hand, velocity, days_of_cover, locations, ship_cost_source, ship_cost_confidence, ship_pnl_cents` from `sku_dim sk` with the four left joins (`inv_by_sku`, `velocity_30d`, `sku_worst_prov`, `ship_pnl_30d`).

- [ ] **Step 2: Write the re-create migration**

Copy the existing `create or replace view public.v_skus_flat as` body EXACTLY (all CTEs + joins from the file in Step 1) and add two columns to the final SELECT: `sk.do_not_reorder` and `sk.product_id`. The header below documents intent; the `…` marks where the unchanged CTE block from the prior migration is pasted verbatim:

```sql
-- v_skus_flat (Phase 2): expose sku_dim.do_not_reorder (the discontinue flag) and
-- product_id (Shopify Product GID, needed by the discontinue executor) on the
-- inventory view. Re-creates the view verbatim from
-- 20260616150000_v_skus_flat_ship_pnl_real_cost_only.sql, adding only the two
-- trailing columns. security_invoker preserved (see 20260604140000). RLS via the
-- base tables is unchanged.
create or replace view public.v_skus_flat
  with (security_invoker = true)
as
  -- … (paste the CTE block from 20260616150000 verbatim: with-clauses for
  --    inv_by_sku, velocity_30d, sku_worst_prov, ship_pnl_30d) …
  select
    sk.id,
    sk.shop_id,
    sk.title,
    sk.sku,
    sk.product_id,
    sk.do_not_reorder,
    coalesce(inv.on_hand, 0)          as on_hand,
    coalesce(v.units_per_day, 0)      as velocity,
    case
      when coalesce(v.units_per_day, 0) > 0
        then round(coalesce(inv.on_hand, 0)::numeric / v.units_per_day, 1)
      when coalesce(inv.on_hand, 0) > 0 then 999
      else 0
    end                                as days_of_cover,
    coalesce(inv.locations, '{}')     as locations,
    wp.ship_cost_source,
    wp.ship_cost_confidence,
    sp.ship_pnl_cents
  from sku_dim sk
  left join inv_by_sku inv       on inv.sku_id = sk.id   and inv.shop_id = sk.shop_id
  left join velocity_30d v       on v.sku_id   = sk.id   and v.shop_id   = sk.shop_id
  left join sku_worst_prov wp    on wp.sku_id  = sk.id   and wp.shop_id  = sk.shop_id
  left join ship_pnl_30d sp      on sp.sku_id  = sk.id   and sp.shop_id  = sk.shop_id;
```

> NOTE TO IMPLEMENTER: the `with (security_invoker = true)` clause and the exact CTE bodies MUST match the prior migration. Re-read `20260604140000_views_security_invoker.sql` and `20260616150000_…` and paste their CTEs — do not paraphrase SQL, or the view's row counts/security change silently (rule 12).

- [ ] **Step 3: Verify the projection**

Run: `grep -n "do_not_reorder\|product_id\|security_invoker" supabase/migrations/20260620120500_v_skus_flat_do_not_reorder.sql`
Expected: both columns + the security_invoker clause present.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260620120500_v_skus_flat_do_not_reorder.sql
git commit -m "supabase: surface do_not_reorder + product_id on v_skus_flat"
```

---

## Task 5: Shopify product mutations — archive/unpublish + restore

Mirror the `inventory.server.ts` pattern: a typed `AdminGraphqlClient`, a GraphQL string, response/`userErrors` checking that throws on failure (rule 12), no swallowing.

**Files:**
- Create: `app/lib/shopify/product.server.ts`
- Test: `app/lib/shopify/__tests__/product.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// app/lib/shopify/__tests__/product.test.ts
import { describe, it, expect, vi } from "vitest";
import { discontinueProduct, restoreProduct } from "../product.server";
import type { AdminGraphqlClient } from "../inventory.server";

function adminReturning(body: unknown): AdminGraphqlClient {
  return {
    graphql: vi.fn(async () => ({ json: async () => body }) as unknown as Response),
  };
}

const PRODUCT_GID = "gid://shopify/Product/123";

describe("discontinueProduct", () => {
  it("archives the product and returns its id", async () => {
    const admin = adminReturning({
      data: { productUpdate: { product: { id: PRODUCT_GID, status: "ARCHIVED" }, userErrors: [] } },
    });
    const res = await discontinueProduct(admin, PRODUCT_GID);
    expect(res.productId).toBe(PRODUCT_GID);
    expect(res.previousStatus).toBeNull(); // not read on the write; documented below
    const call = (admin.graphql as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(call[0])).toContain("productUpdate");
    expect(call[1]).toMatchObject({ variables: { input: { id: PRODUCT_GID, status: "ARCHIVED" } } });
  });

  it("throws on userErrors (rule 12 — no silent success)", async () => {
    const admin = adminReturning({
      data: { productUpdate: { product: null, userErrors: [{ field: ["id"], message: "not found" }] } },
    });
    await expect(discontinueProduct(admin, PRODUCT_GID)).rejects.toThrow(/not found/);
  });

  it("throws on top-level GraphQL errors", async () => {
    const admin = adminReturning({ errors: [{ message: "throttled" }] });
    await expect(discontinueProduct(admin, PRODUCT_GID)).rejects.toThrow(/throttled/);
  });
});

describe("restoreProduct", () => {
  it("re-activates the product to the recorded prior status", async () => {
    const admin = adminReturning({
      data: { productUpdate: { product: { id: PRODUCT_GID, status: "ACTIVE" }, userErrors: [] } },
    });
    const res = await restoreProduct(admin, PRODUCT_GID, "ACTIVE");
    expect(res.productId).toBe(PRODUCT_GID);
    const call = (admin.graphql as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1]).toMatchObject({ variables: { input: { id: PRODUCT_GID, status: "ACTIVE" } } });
  });

  it("throws on userErrors", async () => {
    const admin = adminReturning({
      data: { productUpdate: { product: null, userErrors: [{ message: "cannot restore" }] } },
    });
    await expect(restoreProduct(admin, PRODUCT_GID, "ACTIVE")).rejects.toThrow(/cannot restore/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run app/lib/shopify/__tests__/product.test.ts`
Expected: FAIL — cannot resolve `../product.server`.

- [ ] **Step 3: Write the implementation**

```typescript
// app/lib/shopify/product.server.ts
// Discontinue / restore a Shopify product for the discontinue_sku executor.
// Same shape as inventory.server.ts: a typed AdminGraphqlClient, a GraphQL
// string, and response/userErrors checking that THROWS on failure (rule 12 —
// a failed productUpdate must never read as success). Archiving (not deleting)
// keeps the action reversible: restoreProduct flips ProductStatus back.

import type { AdminGraphqlClient } from "./inventory.server";

/** Shopify ProductStatus values we move between. We only ever set ARCHIVED
 *  (discontinue) or restore to the pre-state (typically ACTIVE/DRAFT). */
export type ShopifyProductStatus = "ACTIVE" | "ARCHIVED" | "DRAFT";

export interface ProductUpdateResult {
  productId: string;
  /** Status returned by Shopify after the write. */
  status: string;
  /** Reserved for callers that pre-read status; the write path leaves it null. */
  previousStatus: string | null;
}

const PRODUCT_UPDATE = /* GraphQL */ `
  mutation calderynProductStatus($input: ProductInput!) {
    productUpdate(input: $input) {
      product {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

async function runProductUpdate(
  admin: AdminGraphqlClient,
  productId: string,
  status: ShopifyProductStatus,
): Promise<ProductUpdateResult> {
  if (!productId) throw new Error("productUpdate called with empty product id");
  const response = await admin.graphql(PRODUCT_UPDATE, {
    variables: { input: { id: productId, status } },
  });
  const body = (await response.json()) as {
    data?: {
      productUpdate?: {
        product?: { id: string; status: string } | null;
        userErrors?: Array<{ field?: string[]; message: string }>;
      };
    };
    errors?: Array<{ message: string }>;
  };
  if (body.errors?.length) {
    throw new Error(body.errors.map((e) => e.message).join("; "));
  }
  const payload = body.data?.productUpdate;
  if (payload?.userErrors?.length) {
    throw new Error(payload.userErrors.map((e) => e.message).join("; "));
  }
  const product = payload?.product;
  if (!product?.id) {
    throw new Error("productUpdate returned no product");
  }
  return { productId: product.id, status: product.status, previousStatus: null };
}

/** Archive (and thereby hide from the online store) a product. Reversible via
 *  restoreProduct. */
export async function discontinueProduct(
  admin: AdminGraphqlClient,
  productId: string,
): Promise<ProductUpdateResult> {
  return runProductUpdate(admin, productId, "ARCHIVED");
}

/** Restore a previously-archived product to its recorded prior status. Defaults
 *  to ACTIVE when the pre-state wasn't captured (best-effort, never DRAFT-traps
 *  a previously-live product). */
export async function restoreProduct(
  admin: AdminGraphqlClient,
  productId: string,
  priorStatus: ShopifyProductStatus = "ACTIVE",
): Promise<ProductUpdateResult> {
  return runProductUpdate(admin, productId, priorStatus);
}
```

> NOTE: `productUpdate` with `status: ARCHIVED` removes the product from the Online Store and Point of Sale channels (Shopify treats ARCHIVED as unlisted everywhere), so a separate `publishableUnpublish` call is not required for the customer-facing effect. The internal `do_not_reorder` flag (Task 6) is the durable signal that survives even if a merchant manually re-activates in Shopify admin.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run app/lib/shopify/__tests__/product.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/shopify/product.server.ts app/lib/shopify/__tests__/product.test.ts
git commit -m "shopify/product: archive (discontinue) + restore via productUpdate"
```

---

## Task 6: Internal flag write + product-GID resolver

The flag and the GID both live on `sku_dim`, shop-scoped. The executor resolves them from the alert's `sku` code (never the request body), the same trust boundary `getCurrentUnitCostCents` uses.

**Files:**
- Create: `app/lib/actions/discontinue.server.ts`
- Test: `app/lib/actions/__tests__/discontinue-flag.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// app/lib/actions/__tests__/discontinue-flag.test.ts
import { describe, it, expect, vi } from "vitest";
import { resolveSkuForDiscontinue, setDoNotReorder } from "../discontinue.server";

// Minimal Supabase chain mock: from().select().eq().eq().maybeSingle() and
// from().update().eq().eq().eq().
function sbWith(skuRow: Record<string, unknown> | null) {
  const update = vi.fn(() => ({ eq: () => ({ eq: () => ({ eq: () => ({ error: null }) }) }) }));
  return {
    from: vi.fn(() => ({
      select: () => ({
        eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: skuRow, error: null }) }) }),
      }),
      update,
    })),
    _update: update,
  } as never;
}

describe("resolveSkuForDiscontinue", () => {
  it("returns the sku id + product GID for a shop-owned sku code", async () => {
    const sb = sbWith({ id: "sku-1", product_id: "gid://shopify/Product/9", do_not_reorder: false });
    const res = await resolveSkuForDiscontinue(sb, "shop-1", "SUMMIT-TEE-M");
    expect(res).toEqual({ skuId: "sku-1", productGid: "gid://shopify/Product/9", alreadyFlagged: false });
  });

  it("returns null when the sku code is not found for the shop", async () => {
    const sb = sbWith(null);
    expect(await resolveSkuForDiscontinue(sb, "shop-1", "NOPE")).toBeNull();
  });

  it("returns null product GID when the sku has no product_id (can't archive)", async () => {
    const sb = sbWith({ id: "sku-1", product_id: null, do_not_reorder: false });
    const res = await resolveSkuForDiscontinue(sb, "shop-1", "SUMMIT-TEE-M");
    expect(res).toEqual({ skuId: "sku-1", productGid: null, alreadyFlagged: false });
  });
});

describe("setDoNotReorder", () => {
  it("writes the flag scoped to shop + sku id", async () => {
    const sb = sbWith({ id: "sku-1" });
    await setDoNotReorder(sb, "shop-1", "sku-1", true);
    expect((sb as never as { _update: ReturnType<typeof vi.fn> })._update).toHaveBeenCalledWith({
      do_not_reorder: true,
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run app/lib/actions/__tests__/discontinue-flag.test.ts`
Expected: FAIL — cannot resolve `../discontinue.server`.

- [ ] **Step 3: Write the implementation**

```typescript
// app/lib/actions/discontinue.server.ts
// Internal-flag side of the discontinue_sku executor: resolve the SKU's Shopify
// product GID + current flag state from sku_dim (shop-scoped — the ownership
// guard), and flip the do_not_reorder flag. Both are pure DB ops; the Shopify
// write lives in shopify/product.server.ts and the orchestration in
// alert-action.server.ts.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface ResolvedDiscontinueTarget {
  skuId: string;
  /** Shopify Product GID, or null when sku_dim has no product_id (no archive
   *  possible — the gateway surfaces this rather than offering a dead button). */
  productGid: string | null;
  alreadyFlagged: boolean;
}

/** Resolve a SKU code to its internal id + Shopify product GID + current flag,
 *  shop-scoped. Returns null when the code isn't owned by the shop. */
export async function resolveSkuForDiscontinue(
  sb: SupabaseClient,
  shopId: string,
  skuCode: string,
): Promise<ResolvedDiscontinueTarget | null> {
  const { data, error } = await sb
    .from("sku_dim")
    .select("id, product_id, do_not_reorder")
    .eq("shop_id", shopId)
    .eq("sku", skuCode)
    .maybeSingle();
  if (error) throw error;
  if (!data?.id) return null;
  return {
    skuId: String(data.id),
    productGid: data.product_id ? String(data.product_id) : null,
    alreadyFlagged: data.do_not_reorder === true,
  };
}

/** Set/clear the internal do_not_reorder flag, shop + sku scoped. */
export async function setDoNotReorder(
  sb: SupabaseClient,
  shopId: string,
  skuId: string,
  value: boolean,
): Promise<void> {
  const { error } = await sb
    .from("sku_dim")
    .update({ do_not_reorder: value })
    .eq("shop_id", shopId)
    .eq("id", skuId);
  if (error) throw error;
}
```

> NOTE: the test mock's `update().eq().eq()` has two `.eq()` calls (shop + id); the implementation matches. (The earlier `sbWith` mock chains three `.eq()` to be tolerant; the real code uses two. Adjust the test chain to two `.eq()` if the third is never reached — keep mock and code in agreement.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run app/lib/actions/__tests__/discontinue-flag.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/actions/discontinue.server.ts app/lib/actions/__tests__/discontinue-flag.test.ts
git commit -m "actions/discontinue: sku product-GID resolver + do_not_reorder flag write"
```

---

## Task 7: The `discontinue_sku` alert-action gateway

Modeled exactly on `executeInventoryAlertAction`. New function in the same file. It does NOT reuse `InventoryAlertActionKind` (which is `reallocate_inventory | snooze_alert`); it takes a fixed `discontinue_sku` kind. Trust boundary: target product GID comes from the alert's `sku` → `sku_dim`, never the request body.

**Files:**
- Modify: `app/lib/actions/alert-action.server.ts` (add the new gateway; reuse the `AlertActionClient` interface and the same client/admin/sb/guard pattern)
- Test: `app/lib/actions/__tests__/discontinue-action.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// app/lib/actions/__tests__/discontinue-action.test.ts
import { describe, it, expect, vi } from "vitest";
import { executeDiscontinueAlertAction } from "../alert-action.server";
import type { Alert, AuditEntry, GuardrailConfig } from "../../types";

const ADMIN_OK = {
  graphql: vi.fn(async () => ({
    json: async () => ({
      data: { productUpdate: { product: { id: "gid://shopify/Product/9", status: "ARCHIVED" }, userErrors: [] } },
    }),
  }) as unknown as Response),
};

function alert(p: Partial<Alert>): Alert {
  return {
    id: "a1",
    detector_id: "negative_unit_economics",
    severity: "high",
    status: "open",
    dollar_impact: 50000,
    claude_rank: 1,
    created_at: "2026-06-20T00:00:00Z",
    title: "Summit Logo Tee — M",
    narrative: "n",
    campaign: null,
    campaign_id: null,
    campaign_external_id: null,
    sku: "SUMMIT-TEE-M",
    evidence: {},
    ...(p as Alert),
  };
}

function client(a: Alert, cap = 100000): {
  alerts: { get: ReturnType<typeof vi.fn> };
  guardrails: { get: ReturnType<typeof vi.fn> };
  actions: { execute: ReturnType<typeof vi.fn> };
} {
  return {
    alerts: { get: vi.fn(async () => a) },
    guardrails: { get: vi.fn(async () => ({ dollar_cap_cents: cap }) as GuardrailConfig) },
    actions: {
      execute: vi.fn(async () => ({ id: "au1", outcome: "succeeded" }) as unknown as AuditEntry),
    },
  };
}

// sku_dim resolver mock: returns product GID; flag-write spy.
function sb(productGid: string | null) {
  const update = vi.fn(() => ({ eq: () => ({ eq: () => ({ error: null }) }) }));
  return {
    from: vi.fn(() => ({
      select: () => ({
        eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: "sku-1", product_id: productGid, do_not_reorder: false }, error: null }) }) }),
      }),
      update,
    })),
    _update: update,
  } as never;
}

describe("executeDiscontinueAlertAction", () => {
  const base = {
    shopId: "shop-1",
    alertId: "a1",
    kind: "discontinue_sku" as const,
    idempotencyKey: "idem-1",
  };

  it("happy path: sets flag, archives product, writes audit, acknowledges", async () => {
    const a = alert({});
    const c = client(a);
    const supa = sb("gid://shopify/Product/9");
    // acknowledgeAlert + snoozeAlert are imported from sibling modules; the
    // gateway returns acknowledged=true on the close path. Stub the alert close
    // by asserting on the audit + product call instead.
    const res = await executeDiscontinueAlertAction({ ...base, client: c as never, admin: ADMIN_OK, sb: supa });
    expect(ADMIN_OK.graphql).toHaveBeenCalled();
    expect((supa as never as { _update: ReturnType<typeof vi.fn> })._update).toHaveBeenCalledWith({ do_not_reorder: true });
    expect(c.actions.execute).toHaveBeenCalledWith(
      expect.objectContaining({ alertId: "a1", kind: "discontinue_sku", idempotencyKey: "idem-1" }),
    );
    expect(res.outcome).toBe("succeeded");
  });

  it("rejects a non-open alert with 409", async () => {
    const a = alert({ status: "acknowledged" });
    await expect(
      executeDiscontinueAlertAction({ ...base, client: client(a) as never, admin: ADMIN_OK, sb: sb("gid://shopify/Product/9") }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("rejects when discontinue_sku is not allowed for the detector (403)", async () => {
    const a = alert({ detector_id: "sku_stockout_vs_spend" });
    await expect(
      executeDiscontinueAlertAction({ ...base, client: client(a) as never, admin: ADMIN_OK, sb: sb("gid://shopify/Product/9") }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects when the SKU has no Shopify product GID (no dead button — surfaces why)", async () => {
    const a = alert({});
    await expect(
      executeDiscontinueAlertAction({ ...base, client: client(a) as never, admin: ADMIN_OK, sb: sb(null) }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("rejects when impact exceeds the guardrail dollar cap (403)", async () => {
    const a = alert({ dollar_impact: 999999 });
    await expect(
      executeDiscontinueAlertAction({ ...base, client: client(a, 100000) as never, admin: ADMIN_OK, sb: sb("gid://shopify/Product/9") }),
    ).rejects.toMatchObject({ status: 403 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run app/lib/actions/__tests__/discontinue-action.test.ts`
Expected: FAIL — `executeDiscontinueAlertAction` is not exported.

- [ ] **Step 3: Implement the gateway**

In `app/lib/actions/alert-action.server.ts`, add imports near the existing ones:

```typescript
import { discontinueProduct } from "../shopify/product.server";
import { resolveSkuForDiscontinue, setDoNotReorder } from "./discontinue.server";
```

Then append the gateway (after `executeInventoryAlertAction`):

```typescript
/** Discontinue a SKU's product: set the internal do_not_reorder flag (blocks
 *  create_po_draft, shows on Inventory) AND archive the product on live Shopify.
 *  Same trust contract as executeInventoryAlertAction — every mutation input is
 *  re-derived from the alert record (its sku → sku_dim), never the request body.
 *  Reversible via the discontinue_sku branch in undo.server.ts. */
export async function executeDiscontinueAlertAction(opts: {
  client: AlertActionClient;
  admin: AdminGraphqlClient;
  sb: SupabaseClient;
  shopId: string;
  alertId: string;
  kind: "discontinue_sku";
  idempotencyKey: string;
  actor?: string;
  triggerReason?: string | null;
  signal?: AbortSignal;
}): Promise<{ auditId: string; outcome: string; acknowledged: boolean }> {
  const { client, admin, sb, shopId, alertId, kind, idempotencyKey, actor, triggerReason, signal } = opts;

  const alert = await client.alerts.get(alertId, signal);

  if (alert.status !== "open") {
    throw new CalderynError({
      code: "alert_not_open",
      status: 409,
      message: `This alert is ${alert.status}; actions only apply to open alerts.`,
    });
  }

  const allowed = DETECTOR_TO_ACTIONS[alert.detector_id] ?? ["snooze_alert"];
  if (!allowed.includes(kind)) {
    throw new CalderynError({
      code: "action_not_allowed",
      status: 403,
      message: `"${kind}" is not a permitted action for this alert.`,
    });
  }

  const guardrails = await client.guardrails.get(signal);
  if (alert.dollar_impact > guardrails.dollar_cap_cents) {
    throw new CalderynError({
      code: "guardrail_dollar_cap",
      status: 403,
      message: `This action's impact (${fmtMoney(alert.dollar_impact)}) exceeds the per-action cap of ${fmtMoney(guardrails.dollar_cap_cents)}.`,
    });
  }

  if (!alert.sku) {
    throw new CalderynError({
      code: "discontinue_no_sku",
      status: 422,
      message: "This alert has no SKU to discontinue.",
    });
  }

  const target = await resolveSkuForDiscontinue(sb, shopId, alert.sku);
  if (!target) {
    throw new CalderynError({
      code: "sku_not_found",
      status: 422,
      message: "The alert's SKU was not found for this shop.",
    });
  }
  if (!target.productGid) {
    // Rule 12: surface WHY the move can't run rather than offering a dead button.
    throw new CalderynError({
      code: "discontinue_no_product",
      status: 422,
      message:
        "This SKU has no linked Shopify product, so it can't be archived. Discontinue it in Shopify directly.",
    });
  }

  // 1. Set the internal flag FIRST: a flagged-but-not-archived state is the safe
  //    failure mode (PO drafts are blocked even if the Shopify call later fails),
  //    and the undo clears it regardless.
  await setDoNotReorder(sb, shopId, target.skuId, true);

  // 2. Archive on Shopify. A failure here throws — the audit row below is only
  //    written on success (rule 12: no "succeeded" row for an un-archived product).
  let archivedStatus: string;
  try {
    ({ status: archivedStatus } = await discontinueProduct(admin, target.productGid));
  } catch (err) {
    // Roll the flag back so a failed archive doesn't silently block reorders.
    await setDoNotReorder(sb, shopId, target.skuId, false);
    throw new CalderynError({
      code: "action_failed",
      status: 502,
      message: err instanceof Error ? err.message : "Shopify product archive failed.",
    });
  }

  // 3. ONE audit row. pre_state carries what undo needs: the prior status (ACTIVE
  //    assumed — see restoreProduct default) and that the flag was off.
  const params: Record<string, unknown> = {
    target: alert.sku,
    sku: alert.sku,
    sku_id: target.skuId,
    product_id: target.productGid,
    estimate_cents: alert.dollar_impact,
    archived_status: archivedStatus,
  };
  const audit = await client.actions.execute({ alertId, kind, params, idempotencyKey });

  const acknowledged = await acknowledgeAlert(sb, shopId, alertId);
  void actor;
  void triggerReason;
  return { auditId: audit.id, outcome: audit.outcome ?? "succeeded", acknowledged };
}
```

> NOTE ON pre_state: the audit row written by `client.actions.execute` (the legacy dashboard `actions.execute` path) does not accept a `pre_state` argument in its options shape (see `AlertActionClient.actions.execute`). The undo (Task 8) reads `params.product_id` and restores to ACTIVE via `restoreProduct`'s default, then clears the flag by `params.sku_id`. This matches how `reallocate_inventory` undo reads replay inputs from `params`, not `pre_state`. Keep the undo keyed off `params`, identical to the inventory pattern.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run app/lib/actions/__tests__/discontinue-action.test.ts`
Expected: PASS (5 tests). If the happy-path test fails because `acknowledgeAlert`/`snoozeAlert` hit the DB, stub them with `vi.mock("../alerts.server", () => ({ acknowledgeAlert: vi.fn(async () => true) }))` at the top of the test file — match how `app/routes/__tests__/alert-action-po.test.ts` mocks siblings.

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc --noEmit
git add app/lib/actions/alert-action.server.ts app/lib/actions/__tests__/discontinue-action.test.ts
git commit -m "actions/alert-action: executeDiscontinueAlertAction (flag + Shopify archive)"
```

---

## Task 8: One-click undo — re-publish + clear the flag

Route through the existing generic `undo.server.ts`. Add a `discontinue_sku` branch to the `orig.action_kind` switch (currently `pause_campaign | resume_campaign | reduce_campaign_budget | reallocate_budget | reallocate_inventory | else-throw`). Reading replay inputs from `orig.params` matches the `reallocate_inventory` branch exactly. One name only: there is **no** `undo_discontinue_sku` kind — the undo row reuses `action_kind: "discontinue_sku"` with `undo_of` set, exactly like every other undo.

**Files:**
- Modify: `app/lib/actions/undo.server.ts` (add the branch; reuse `deps.admin`)
- Test: `app/lib/actions/__tests__/undo-discontinue.test.ts`

- [ ] **Step 1: Write a failing test**

```typescript
// app/lib/actions/__tests__/undo-discontinue.test.ts
import { describe, it, expect, vi } from "vitest";
import { undoAction } from "../undo.server";

// Admin client whose productUpdate(ACTIVE) succeeds.
const ADMIN_OK = {
  graphql: vi.fn(async () => ({
    json: async () => ({
      data: { productUpdate: { product: { id: "gid://shopify/Product/9", status: "ACTIVE" }, userErrors: [] } },
    }),
  }) as unknown as Response),
};

// Supabase mock: the original discontinue_sku audit row, no existing undo, in-window;
// captures the flag-clear update + the inserted undo row + the alert re-open.
function makeSb() {
  const origRow = {
    id: "au1",
    shop_id: "shop-1",
    alert_id: "a1",
    action_kind: "discontinue_sku",
    params: { sku_id: "sku-1", product_id: "gid://shopify/Product/9" },
    pre_state: {},
    post_state: {},
    dollar_impact_at_exec: 500,
    undo_of: null,
    outcome: "succeeded",
    created_at: new Date().toISOString(),
  };
  const skuUpdate = vi.fn(() => ({ eq: () => ({ eq: () => ({ error: null }) }) }));
  const calls: string[] = [];
  const sb = {
    from: vi.fn((table: string) => {
      calls.push(table);
      if (table === "action_audit") {
        return {
          select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: origRow, error: null }) }), limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
          insert: () => ({ select: () => ({ single: async () => ({ data: { id: "undo1" }, error: null }) }) }),
        };
      }
      if (table === "sku_dim") return { update: skuUpdate };
      if (table === "alerts") return { update: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ error: null }) }) }) }) };
      return {};
    }),
    _skuUpdate: skuUpdate,
  };
  return sb as never;
}

describe("undoAction — discontinue_sku", () => {
  it("re-activates the product, clears the flag, and writes an undo row", async () => {
    const sb = makeSb();
    const res = await undoAction("shop-1", "au1", sb, { admin: ADMIN_OK });
    expect(ADMIN_OK.graphql).toHaveBeenCalled();
    expect((sb as never as { _skuUpdate: ReturnType<typeof vi.fn> })._skuUpdate).toHaveBeenCalledWith({ do_not_reorder: false });
    expect(res.id).toBe("undo1");
  });

  it("refuses without an admin client (rule 12 — no fake undo)", async () => {
    const sb = makeSb();
    await expect(undoAction("shop-1", "au1", sb, {})).rejects.toThrow(/admin/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/lib/actions/__tests__/undo-discontinue.test.ts`
Expected: FAIL — current `undo.server.ts` hits the `else` branch and throws `undo not supported for action kind discontinue_sku`.

- [ ] **Step 3: Add the undo branch**

In `app/lib/actions/undo.server.ts`, add imports at the top (next to the inventory import):

```typescript
import { restoreProduct } from "../shopify/product.server";
import { setDoNotReorder } from "./discontinue.server";
```

Add a branch in the `orig.action_kind` chain, placed BEFORE the final `else` (after the `reallocate_inventory` branch):

```typescript
  } else if (orig.action_kind === "discontinue_sku") {
    // Reverse a discontinue: re-activate the product on Shopify, then clear the
    // internal flag. Refuse loudly without an admin client rather than record a
    // success that never touched Shopify (rule 12 — same stance as inventory).
    if (!deps.admin) {
      throw new Error("Shopify admin client unavailable; cannot undo a product discontinue");
    }
    const dp = (orig.params ?? {}) as { sku_id?: string; product_id?: string };
    if (!dp.product_id || !dp.sku_id) {
      throw new Error(`audit ${auditId} lacks the product/sku to restore; cannot undo`);
    }
    // Restore to ACTIVE (restoreProduct's default — the pre-status isn't captured
    // on the write path; a previously-DRAFT product re-activating is the safe,
    // visible default rather than staying archived).
    await restoreProduct(deps.admin, dp.product_id, "ACTIVE");
    await setDoNotReorder(sb, shopId, dp.sku_id, false);
  } else {
```

(The `} else {` line is the EXISTING final else — you are inserting the new `} else if … {` block immediately above it, so the existing `else` now follows your block.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run app/lib/actions/__tests__/undo-discontinue.test.ts`
Expected: PASS (2 tests). The undo row insert (shared tail) sets `action_kind: orig.action_kind` (= `"discontinue_sku"`), `undo_of: orig.id`, and the alert re-open already runs for any `orig.alert_id` — no extra code needed there.

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc --noEmit
git add app/lib/actions/undo.server.ts app/lib/actions/__tests__/undo-discontinue.test.ts
git commit -m "actions/undo: discontinue_sku branch (restore product + clear flag)"
```

---

## Task 9: Wire the dashboard action route

`/dashboard/api/alerts/$id/action` currently allows `reallocate_inventory | snooze_alert` and dispatches to `executeInventoryAlertAction`. Add `discontinue_sku` and dispatch it to the new gateway.

**Files:**
- Modify: `app/routes/dashboard.api.alerts.$id.action.tsx`

- [ ] **Step 1: Allow the kind and branch the dispatch**

Replace the imports + `KINDS` + the `executeInventoryAlertAction` call. The route's `KINDS` allow-list and dispatch become:

```typescript
import {
  executeInventoryAlertAction,
  executeDiscontinueAlertAction,
  type InventoryAlertActionKind,
} from "~/lib/actions/alert-action.server";
import type { ActionKind } from "~/lib/types";

const KINDS: ActionKind[] = ["reallocate_inventory", "snooze_alert", "discontinue_sku"];
```

Then in the action body, after validating `kind`/`idempotencyKey`, branch on the kind inside the `dashboardJson` callback:

```typescript
  return dashboardJson(async () => {
    const { admin } = await unauthenticated.admin(session.shopDomain);
    if (kind === "discontinue_sku") {
      const { auditId, outcome, acknowledged } = await executeDiscontinueAlertAction({
        client,
        admin,
        sb: getSupabase(),
        shopId: session.shopId,
        alertId,
        kind: "discontinue_sku",
        idempotencyKey,
        signal: request.signal,
      });
      return { audit_id: auditId, outcome, acknowledged };
    }
    const { auditId, outcome, acknowledged } = await executeInventoryAlertAction({
      client,
      admin,
      sb: getSupabase(),
      shopId: session.shopId,
      alertId,
      kind: kind as InventoryAlertActionKind,
      idempotencyKey,
      signal: request.signal,
    });
    return { audit_id: auditId, outcome, acknowledged };
  });
```

Note `kind` is now typed `ActionKind` (from `body.type`); the `KINDS.includes(kind)` guard above narrows it. Keep that guard; cast to `InventoryAlertActionKind` only in the non-discontinue branch as shown.

- [ ] **Step 2: Typecheck + lint**

Run: `npx tsc --noEmit && npx eslint app/routes/dashboard.api.alerts.$id.action.tsx`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add app/routes/dashboard.api.alerts.$id.action.tsx
git commit -m "dashboard/api/alerts: route discontinue_sku to its executor"
```

---

## Task 10: Embedded route — execute `discontinue_sku` + gate `create_po_draft`

Two changes in `app/routes/app.alerts.$id.tsx`: (a) handle `discontinue_sku` in the action, (b) block `create_po_draft` when the SKU is flagged `do_not_reorder` (rule 12 — a discontinued product must never be re-orderable).

**Files:**
- Modify: `app/routes/app.alerts.$id.tsx` (the `create_po_draft` action block ~233–285; add a `discontinue_sku` branch; the loader for the flag)

- [ ] **Step 1: Block create_po_draft when the SKU is flagged**

Inside the existing `if (kind === "create_po_draft")` block (after the `if (!alert.sku)` guard, before `buildPoDraft`), add the flag check. Reuse the resolver from Task 6:

```typescript
      // A discontinued SKU must never be re-orderable (rule 12). Resolve the
      // flag shop-scoped from sku_dim and refuse loudly if set.
      {
        const sbCheck = getSupabase();
        const shopIdCheck = await resolveShopId(session.shop);
        const target = await resolveSkuForDiscontinue(sbCheck, shopIdCheck, alert.sku);
        if (target?.alreadyFlagged) {
          throw new CalderynError({
            code: "SKU_DISCONTINUED",
            status: 409,
            message:
              "This product is marked Do Not Reorder. Restore it (undo the discontinue) before drafting a purchase order.",
          });
        }
      }
```

Add the import at the top of the route:

```typescript
import { resolveSkuForDiscontinue } from "~/lib/actions/discontinue.server";
import { executeDiscontinueAlertAction } from "~/lib/actions/alert-action.server";
```

- [ ] **Step 2: Handle `discontinue_sku` in the action**

`discontinue_sku` must NOT fall through to the legacy `client.actions.execute` path (which would archive nothing). Add a branch directly before the `executableKinds` campaign block (so it runs after the guardrail cap, which already covers it). The gateway re-checks the cap itself, so this branch can be self-contained:

```typescript
    if (kind === "discontinue_sku") {
      const shopId = await resolveShopId(session.shop);
      const { outcome, acknowledged } = await executeDiscontinueAlertAction({
        client,
        admin,
        sb: getSupabase(),
        shopId,
        alertId,
        kind: "discontinue_sku",
        idempotencyKey,
        signal: request.signal,
      });
      return json<ActionPayload>({
        ok: outcome === "succeeded",
        toast: {
          message:
            outcome === "succeeded"
              ? `Product discontinued — archived on Shopify and marked Do Not Reorder.${acknowledged ? "" : " Alert couldn't be acknowledged."}`
              : "Discontinue recorded as failed — check the audit log.",
          isError: outcome !== "succeeded",
        },
      });
    }
```

(`admin` is already in scope in this action — it's the authenticated Admin client used by the `reallocate_inventory`/`create_po_draft` branches above. Confirm with `grep -n "const { admin }\|admin," app/routes/app.alerts.$id.tsx`.)

- [ ] **Step 3: Typecheck + lint**

Run: `npx tsc --noEmit && npx eslint app/routes/app.alerts.$id.tsx`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add app/routes/app.alerts.$id.tsx
git commit -m "app.alerts.\$id: execute discontinue_sku + block PO draft on flagged SKU"
```

---

## Task 11: Embedded Fix-it panel — render the discontinue button

The Phase-1 embedded panel renders remediation moves with `executor !== "snooze_alert"` as advisory `Text` rows. Generalize: a move with `executor !== null` renders as a Polaris `Button` that submits the action; `executor === null` stays an advisory row.

**Files:**
- Modify: `app/routes/app.alerts.$id.tsx` (the remediation block inside the "Recommended actions" Card — Phase 1 Task 9)

- [ ] **Step 1: Replace the advisory-only `.map` with an executor-aware render**

In the `{alert.remediation && (…)}` block, replace the `.filter((m) => m.executor !== "snooze_alert").map(...)` body so executable non-snooze moves render a Button. Snooze still flows through the existing `allowedActions.map` below (do not duplicate it here):

```tsx
                    {alert.remediation.moves
                      .filter((m) => m.kind !== "snooze")
                      .map((m) => {
                        const rec = m.kind === alert.remediation!.recommended;
                        if (m.executor) {
                          // Executable move (Phase 2: discontinue_sku). The kind
                          // submitted is the EXECUTOR, which the action handler +
                          // DETECTOR_TO_ACTIONS gate on.
                          return (
                            <InlineStack key={m.kind} gap="200" blockAlign="center" wrap={false}>
                              {rec && <Badge tone="success">Recommended</Badge>}
                              <Button
                                variant={rec ? "primary" : "secondary"}
                                tone={m.executor === "discontinue_sku" ? "critical" : undefined}
                                loading={navigation.state !== "idle" && actionKind === m.executor}
                                onClick={() => setActionKind(m.executor as ActionKind)}
                              >
                                {m.label}
                              </Button>
                            </InlineStack>
                          );
                        }
                        // Advisory move (cut_ads / reallocate_to_winner / fix_returns
                        // / review_pricing) — still guidance text in Phase 2.
                        return (
                          <InlineStack key={m.kind} gap="150" blockAlign="center" wrap={false}>
                            {rec && <Badge tone="success">Recommended</Badge>}
                            <Text as="span" variant="bodyMd" fontWeight={rec ? "semibold" : "regular"}>
                              {m.label}
                            </Text>
                          </InlineStack>
                        );
                      })}
```

`setActionKind(m.executor)` opens the existing inline confirm modal (the same path Snooze and other inline kinds use), which on confirm POSTs `discontinue_sku` to this route's action — handled in Task 10. `discontinue_sku` must be present in the modal's allowed kinds: it is, via `DETECTOR_TO_ACTIONS` (Task 1) and the `inlineKinds` filter (it is not a `DEEP_LINK_ACTIONS` entry).

- [ ] **Step 2: Confirm the confirm-modal covers `discontinue_sku`**

Run: `grep -n "DEEP_LINK_ACTIONS\|ConfirmModal\|actionKind\|confirm" app/routes/app.alerts.$id.tsx | head`
Confirm `discontinue_sku` is NOT in `DEEP_LINK_ACTIONS` (so it opens an inline confirm, not a deep-link). If the confirm modal hard-codes copy per kind, add a `discontinue_sku` case: title "Discontinue this product?", body naming the SKU + that it archives on Shopify and is reversible from the audit log.

- [ ] **Step 3: Typecheck + lint**

Run: `npx tsc --noEmit && npx eslint app/routes/app.alerts.$id.tsx`
Expected: exit 0. (`Button` is already imported in this Polaris file; confirm with `grep -n "Button" app/routes/app.alerts.$id.tsx`.)

- [ ] **Step 4: Commit**

```bash
git add app/routes/app.alerts.$id.tsx
git commit -m "app.alerts.\$id: render discontinue as an executable button (Polaris)"
```

---

## Task 12: Dashboard Fix-it panel + `executeAction` — discontinue button

The Phase-1 dashboard panel renders non-snooze moves as `cd-move-row` divs. Generalize: a move with `executor !== null` renders a real `cd-action-btn` calling `run(m.executor)`; `executor === null` stays a `cd-move-row`. Wire `executeAction` to POST `discontinue_sku` to the live alert-action endpoint.

**Files:**
- Modify: `app/components/dashboard/screens/Alerts.tsx` (the remediation branch of the Fix-it Card — Phase 1 Task 8)
- Modify: `app/components/dashboard/DashboardApp.tsx` (`executeAction`, add a `discontinue_sku` branch ~before the `reallocate_inventory` branch)

- [ ] **Step 1: Render executable moves as buttons in the panel**

In the `alert.remediation.moves.map(...)` body, replace the snooze-only button check so ANY move with a live executor renders a button (calling `run(m.executor)`), and advisory moves stay rows:

```tsx
                  {alert.remediation.moves.map((m) => {
                    const rec = m.kind === alert.remediation!.recommended;
                    if (m.executor) {
                      // Executable move: snooze (Phase 1) or discontinue_sku (Phase 2).
                      const isDiscontinue = m.executor === "discontinue_sku";
                      return (
                        <button
                          key={m.kind}
                          disabled={resolved || busy}
                          aria-busy={busy && attempted === m.executor}
                          className={"cd-action-btn" + (rec ? " rec" : "") + (isDiscontinue ? " danger" : "")}
                          onClick={() => run(m.executor as ActionKind)}
                        >
                          <CDIcon name={CD_ACTION_ICON[m.executor] || "bolt"} size={16} strokeWidth={1.9} />
                          <span className="flex-1 text-left">{m.label}</span>
                          {rec && <span className="cd-rec-tag">Recommended</span>}
                        </button>
                      );
                    }
                    return (
                      <div
                        key={m.kind}
                        className={"cd-move-row" + (rec ? " rec" : "")}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          padding: "10px 12px",
                          borderRadius: 10,
                          border: "1px solid var(--border)",
                          background: rec ? "var(--surface-2)" : "transparent",
                        }}
                      >
                        <CDIcon name={CD_ACTION_ICON[m.kind] || "bolt"} size={16} strokeWidth={1.9} />
                        <span className="flex-1 text-left">{m.label}</span>
                        {rec && <span className="cd-rec-tag">Recommended</span>}
                      </div>
                    );
                  })}
```

(Update the trailing caption from Phase 1's "One-click execution for these moves is rolling out." to "Advisory moves are guidance; the highlighted action runs with one click." since discontinue now runs.)

- [ ] **Step 2: Add the `discontinue_sku` branch in `executeAction`**

In `app/components/dashboard/DashboardApp.tsx`, add a branch in the `executeAction` callback, placed right before the existing `reallocate_inventory` branch (it uses the same live alert-action endpoint, `client.executeAlertAction`, which generates the idempotency key):

```typescript
      // discontinue_sku: live endpoint — archives the product on Shopify and
      // sets the internal Do-Not-Reorder flag, both derived server-side from the
      // alert. A failure (e.g. SKU with no Shopify product) surfaces as an error
      // toast, never a fake resolution.
      if (kind === "discontinue_sku") {
        try {
          const { acknowledged } = await client.executeAlertAction(alert.id, { type: kind });
          markResolved();
          client
            .fetchAudit()
            .then((au) => setAudit(au))
            .catch(() => {});
          toast(
            `${label} — product archived and marked Do Not Reorder.` +
              (acknowledged ? "" : " Alert couldn't be acknowledged."),
            "check",
          );
        } catch (err) {
          const msg = err instanceof DashboardApiError ? err.message : "Action failed.";
          toast(msg, "warn", "critical");
        }
        return;
      }
```

Confirm `client.executeAlertAction(alertId, { type })` accepts `discontinue_sku` — its `type` is typed as the action kind and it generates `idempotency_key: crypto.randomUUID()` internally (`app/lib/dashboard/client.ts:619-626`). If its `type` parameter is a narrowed union, widen it to `ActionKind` (or add `"discontinue_sku"`) so the call typechecks.

- [ ] **Step 3: Typecheck + lint**

Run: `npx tsc --noEmit && npx eslint app/components/dashboard/screens/Alerts.tsx app/components/dashboard/DashboardApp.tsx`
Expected: exit 0.

- [ ] **Step 4: Manual verification (no component test harness)**

Run the dashboard against seed data, open a **structurally-dead** product-economics alert (gross margin ≤ 0 — e.g. a `negative_unit_economics` alert with `gross_unit_margin_usd ≤ 0`).
Expected: the Fix-it panel shows the synopsis, a **"Stop reordering & archive product"** button tagged **Recommended** (danger-styled), and a working **Snooze** button. Clicking discontinue archives the product, shows the success toast, resolves the alert, and adds an audit row with an Undo affordance.

- [ ] **Step 5: Commit**

```bash
git add app/components/dashboard/screens/Alerts.tsx app/components/dashboard/DashboardApp.tsx
git commit -m "dashboard: render + execute discontinue_sku from the Fix-it panel"
```

---

## Task 13: Surface the flag on Inventory

`do_not_reorder` must show on the Inventory surface (spec requirement). Carry it onto the `SKU`/`SkuVM` DTO and render a pill.

**Files:**
- Modify: `app/lib/types.ts` (`SKU` interface — add `do_not_reorder: boolean`)
- Modify: `app/lib/calderyn.server.ts` (`rowToSku` ~197 — read `r.do_not_reorder`)
- Modify: `app/components/dashboard/view-models.ts` (`SkuVM` — add `do_not_reorder: boolean`)
- Modify: `app/lib/dashboard/client.ts` (the `adaptSku`/SKU mapper — pass it through)
- Modify: `app/components/dashboard/screens/Inventory.tsx` (render a "Won't reorder" pill)

- [ ] **Step 1: Add `do_not_reorder` to the `SKU` DTO + `rowToSku`**

In `app/lib/types.ts`, add to the `SKU` interface (after `ship_pnl_cents`):

```typescript
  /** Internal "do not reorder" flag — set by discontinue_sku, blocks PO drafts.
   *  Surfaced on the Inventory surface. */
  do_not_reorder: boolean;
```

In `app/lib/calderyn.server.ts` `rowToSku`, add to the returned object (after `ship_pnl_cents`):

```typescript
    do_not_reorder: r.do_not_reorder === true,
```

- [ ] **Step 2: Carry it onto `SkuVM` + its mapper**

In `app/components/dashboard/view-models.ts`, add `do_not_reorder: boolean;` to `SkuVM`. In `app/lib/dashboard/client.ts`, find the SKU→`SkuVM` mapper (grep `adaptSku` or the `SkuVM` return) and add `do_not_reorder: s.do_not_reorder ?? false,` to its returned object.

- [ ] **Step 3: Render the pill on Inventory**

In `app/components/dashboard/screens/Inventory.tsx`, in the per-SKU row (near the existing `<ShipCostPill>` / status `<Pill>` around lines 466–474), add a conditional pill:

```tsx
                      {s.do_not_reorder && <Pill tone="critical">Won&apos;t reorder</Pill>}
```

- [ ] **Step 4: Typecheck + lint + commit**

Run: `npx tsc --noEmit && npx eslint app/lib/calderyn.server.ts app/components/dashboard/screens/Inventory.tsx`
Expected: exit 0. (Every `SKU` literal must now set `do_not_reorder`; if a seed/test builds one, add `do_not_reorder: false`.)

```bash
git add app/lib/types.ts app/lib/calderyn.server.ts app/components/dashboard/view-models.ts app/lib/dashboard/client.ts app/components/dashboard/screens/Inventory.tsx
git commit -m "inventory: surface do_not_reorder flag on the SKU surface"
```

---

## Task 14: `write_products` OAuth scope + App Store review note

`productUpdate` requires `write_products`. The app's current scopes are `read_inventory,read_locations,read_orders,read_products,write_inventory`.

**Files:**
- Modify: `shopify.app.calderynextension.toml` (`[access_scopes].scopes`, line 10)
- Create: `docs/superpowers/HANDOFF-discontinue-sku-scope.md` (App Store review note)

- [ ] **Step 1: Add the scope**

In `shopify.app.calderynextension.toml`, change line 10:

```toml
scopes = "read_inventory,read_locations,read_orders,read_products,write_inventory,write_products"
```

- [ ] **Step 2: Write the review/reconnection note**

Create `docs/superpowers/HANDOFF-discontinue-sku-scope.md`:

```markdown
# Handoff: write_products scope for discontinue_sku (Phase 2)

## What changed
`shopify.app.calderynextension.toml` adds `write_products` to access_scopes.

## Why
The `discontinue_sku` remediation executor archives a money-losing product on
Shopify via the `productUpdate` Admin GraphQL mutation (`ProductStatus.ARCHIVED`),
and re-activates it on undo. Both require `write_products`. `read_products` (already
held) is insufficient for the write.

## Merchant impact — scope re-grant
Adding a scope forces a **re-authorization**: existing installs must re-consent on
next load (Shopify shows the updated permission screen). The embedded app already
handles the standard OAuth re-grant via `@shopify/shopify-app-remix`; no extra code.
Until a merchant re-grants, `productUpdate` calls 403 — the executor surfaces this as
a failed audit row + error toast (rule 12), never a silent no-op. **Action item:** flag
this in release notes so support expects the one-time re-consent prompt.

## App Store review note (paste into the submission)
> Calderyn requests `write_products` to let merchants discontinue an unprofitable
> product directly from a money-loss alert. The app archives the product
> (`productUpdate` → ARCHIVED), which is fully reversible from the in-app audit log
> (one-click undo re-activates it). The app never deletes products. The write is only
> triggered by an explicit merchant action (or, in a later release, autopilot within
> merchant-set guardrails) on a product the app has flagged as losing money.

## Verify
`shopify app config push` (or the deploy pipeline) propagates the scope change to the
Partner dashboard. Confirm the live app's "API access" lists write_products before
shipping the executor.
```

- [ ] **Step 3: Commit**

```bash
git add shopify.app.calderynextension.toml docs/superpowers/HANDOFF-discontinue-sku-scope.md
git commit -m "shopify: add write_products scope for discontinue_sku + App Store note"
```

---

## Task 15: Full gate + final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full Phase-2 test suite**

Run: `npx vitest run app/lib/remediation app/lib/shopify/__tests__/product.test.ts app/lib/actions/__tests__/discontinue-flag.test.ts app/lib/actions/__tests__/discontinue-action.test.ts app/lib/actions/__tests__/undo-discontinue.test.ts`
Expected: PASS (engine executor + product mutations + flag + gateway + undo all green).

- [ ] **Step 2: Run the repo pre-commit gate (per CLAUDE.md)**

Run: `npm run typecheck && npm run lint && npm run build && npm test`
Expected: each exits 0. Migrations changed → also run `npx prisma migrate diff --exit-code` only if `prisma/schema.prisma` was touched (it was not — these are Supabase SQL migrations); confirm the two new `.sql` files parse and no existing migration was edited. Fix root causes; do not `--no-verify`, disable lint, or narrow types (rule 12).

- [ ] **Step 3: Patch sanity**

Run: `git diff --check` and `git log --oneline -15`
Expected: no whitespace errors; no stray `console.log`, `.only`, `TODO(me)`, or commented-out blocks in the diff.

- [ ] **Step 4: `/code-review` the branch and resolve blockers**

Run the `/code-review` slash command on the working tree; resolve every blocker, downgrade nits with a one-line justification.

---

## Self-review (against the spec)

- **Spec §Phase 2 scope (`discontinue_sku` executor):**
  - Internal `do_not_reorder` flag → Task 3 (column), Task 6 (write), Task 13 (Inventory surface). ✓
  - Flag BLOCKS `create_po_draft` → Task 10 Step 1 (the only PO-draft execution path, in `app.alerts.$id.tsx`). ✓
  - Live Shopify archive/unpublish via `productUpdate` → Task 5 (`discontinueProduct` → `ProductStatus.ARCHIVED`). ✓
  - One-click undo (re-publish + clear flag) → Task 8 (`discontinue_sku` branch in `undo.server.ts` → `restoreProduct` + `setDoNotReorder(false)`). ✓
  - New `write_products` scope + App Store review note → Task 14. ✓
  - Through existing action/audit/undo infra (idempotency, ONE audit row, acknowledge-on-success, guardrail cap) → Task 7 (gateway reuses `client.actions.execute` → `insertAuditWithIdempotency`; cap + 409/403 gates mirror `executeInventoryAlertAction`). ✓
  - Executable button on BOTH Fix-it panels → Task 11 (embedded Polaris) + Task 12 (dashboard). ✓
- **Spec §Failure visibility (rule 12):** missing product GID → 422 with reason (Task 7); failed archive rolls the flag back + throws 502 (Task 7); undo without admin client refuses (Task 8); PO draft on flagged SKU → 409 (Task 10); no dead buttons — the engine only shows discontinue when eligible (Phase 1 `rank.ts`), and the executor surfaces every block reason. ✓
- **Spec §The deterministic ranking / cross-phase contract:** `StrategicMove.executor` widened to `"snooze_alert" | "discontinue_sku" | null` (union kept open for Phase 3) — Task 2; `rank.ts` sets `executor: "discontinue_sku"` on the discontinue move — Task 2. ✓
- **Spec §Architecture (shared engine):** both surfaces read the same `RemediationPlan` from `attachRemediation` (Phase 1); Phase 2 only adds executors + button rendering — no forked decision logic. ✓
- **Spec §Dashboard parity:** Task 11 (embedded) + Task 12 (dashboard) translate the same contract into each surface's primitives. ✓
- **Deferred (stated in Scope):** autopilot wiring (Phase 4), `reallocate_spend_sku` (Phase 3), `remediation jsonb` caching (Phase 4). ✓

### Type-consistency check (spelled identically everywhere)

- **`discontinue_sku`** (the `ActionKind`): `app/lib/types.ts` (union), `app/lib/labels.ts` (`ACTION_LABELS`/`ACTION_VERBS`/`DETECTOR_TO_ACTIONS`), `app/components/dashboard/icons.tsx` (`CD_ACTION_ICON`), `app/lib/remediation/{types,rank}.ts` (`StrategicMove.executor`), `app/lib/actions/alert-action.server.ts` (gateway `kind`), `app/lib/actions/undo.server.ts` (branch), `app/routes/dashboard.api.alerts.$id.action.tsx` (`KINDS` + dispatch), `app/routes/app.alerts.$id.tsx` (action branch + button), `app/components/dashboard/DashboardApp.tsx` (`executeAction` branch). One spelling, no variants.
- **The undo:** there is NO separate `undo_discontinue_sku` kind. The undo row reuses `action_kind: "discontinue_sku"` with `undo_of` set, routed through the generic `undoAction` — identical to `reallocate_inventory`. One name, one path.
- **`do_not_reorder`** (the flag column/field): `sku_dim.do_not_reorder` (both migrations), `v_skus_flat.do_not_reorder`, `resolveSkuForDiscontinue`/`setDoNotReorder` (`discontinue.server.ts`), `SKU.do_not_reorder` (`types.ts`), `SkuVM.do_not_reorder` (`view-models.ts`), `rowToSku`/`adaptSku`. One spelling throughout.
- **`StrategicMove.executor`** union: `"snooze_alert" | "discontinue_sku" | null` — declared once in `types.ts`, consumed by `rank.ts` and both panels; kept open so Phase 3 appends `"reallocate_spend_sku"` without breaking it.
- **No placeholders:** every code step shows complete code; UI tasks ship full JSX/TSX; SQL tasks specify the exact columns added (the one verbatim-paste is the unchanged `v_skus_flat` CTE block, explicitly flagged to copy from the named prior migration, not invent).
