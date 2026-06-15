# Audit Log Legibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every audited action legible and trustworthy by surfacing, on both the Shopify extension and the Calderyn dashboard, (1) the booked-margin source — provenance + cost-data lineage, (2) why the action fired, and (3) whether it was manual or automatic.

**Architecture:** A single pure module `app/lib/audit-legibility.ts` turns an enriched `AuditEntry` into a display-ready `AuditLegibility` object that both surfaces render in their own primitives (Polaris vs dashboard). Mode, margin-basis, cost-lineage labels and the "why" line are derived at read-time (retroactive, no backfill); only the autopilot path persists a new `trigger_reason` column going forward. Cost lineage is resolved server-side in `calderyn.server.ts › audit.list` with one batched query and rides on `AuditEntry.cost_sources`.

**Tech Stack:** Remix + TypeScript (strict), Supabase Postgres (app data, `action_audit` / `v_audit_view`), Polaris (extension UI), dashboard's own React primitives, Vitest, `@shopify/supabase` MCP for migrations.

**Source spec:** `docs/superpowers/specs/2026-06-15-audit-legibility-design.md`

**Worktree:** Create `feat/audit-legibility` via the `superpowers:using-git-worktrees` skill before Task 1.

---

## File structure

| File | Responsibility | Change |
|---|---|---|
| `supabase/migrations/20260615T130000_action_audit_trigger_reason.sql` | `trigger_reason` column + recreate `v_audit_view` exposing it plus `param_sku_id`/`param_platform` | Create |
| `app/lib/types.ts` | `CostSource` type; `AuditEntry.trigger_reason`, `AuditEntry.cost_sources` | Modify |
| `app/lib/audit-legibility.ts` | Pure derivation: mode, marginBasis(+label), costLineage, why/whyDetail; exported action-class sets | Create |
| `app/lib/__tests__/audit-legibility.test.ts` | Behavior tests for the module + anti-drift basis check | Create |
| `app/lib/labels.ts` | `actorLabel` normalization, `MARGIN_BASIS_LABELS`, `COST_SOURCE_LABELS` | Modify |
| `app/lib/__tests__/labels-actor.test.ts` | actor normalization regression | Create |
| `app/lib/actions/execute.server.ts` | `triggerReason?` on `ExecuteInput` + `AuditInsert`, written to row | Modify |
| `app/lib/actions/reallocate.server.ts` | `triggerReason?` on `ReallocateInput`, passed to insert | Modify |
| `app/lib/actions/autopilot.server.ts` | Build a plain-language reason, thread it into both executors | Modify |
| `app/lib/actions/__tests__/autopilot.test.ts` | Assert `trigger_reason` is written | Modify |
| `app/lib/calderyn.server.ts` | `rowToAudit` reads `trigger_reason`; `audit.list` batch-resolves `cost_sources` | Modify |
| `app/components/dashboard/view-models.ts` | `AuditVM` legibility fields | Modify |
| `app/lib/dashboard/client.ts` | `adaptAudit` calls `auditLegibility` | Modify |
| `app/lib/dashboard/__tests__/adapt-audit.test.ts` | AuditVM carries legibility fields | Modify |
| `app/components/dashboard/icons.tsx` | add `chevronDown` to `CD_ICONS` | Modify |
| `app/components/dashboard/screens/Audit.tsx` | expandable rows, Auto/Manual pill, source + why captions | Modify |
| `app/routes/app.audit.tsx` | `DataTable` → `IndexTable`, expandable detail, inline badges | Modify |

---

## Task 1: Migration — `trigger_reason` column + view

**Files:**
- Create: `supabase/migrations/20260615T130000_action_audit_trigger_reason.sql`

The current view (from `pg_get_viewdef`) coalesces `target` from `params` and joins `alerts` for `detector_id`. We recreate it adding `trigger_reason` and two scalar params projections, then re-assert `security_invoker` (recreating drops view options).

- [ ] **Step 1: Write the migration SQL**

```sql
-- action_audit.trigger_reason: a plain-language note the autopilot writes at the
-- decision point explaining why it acted. Null on manual rows (the "why" is
-- derived from the alert). No backfill — there are no autopilot rows yet.
alter table public.action_audit add column if not exists trigger_reason text;

-- Recreate v_audit_view to expose trigger_reason and two scalar params lookups
-- (sku_id, platform) that audit.list uses to resolve cost-data lineage without
-- exposing the full params blob to the client.
create or replace view public.v_audit_view as
  select
    aa.id,
    aa.shop_id,
    aa.action_kind::text as action_kind,
    case
      when aa.outcome = any (array['succeeded'::action_outcome, 'failed'::action_outcome]) then aa.outcome::text
      else 'failed'::text
    end as outcome,
    coalesce(aa.params ->> 'target', aa.params ->> 'campaign_name', aa.params ->> 'sku',
             aa.params ->> 'campaign_id', aa.params ->> 'sku_id', '') as target,
    coalesce(aa.dollar_impact_at_exec, 0::numeric) as dollar_impact_at_exec,
    coalesce(aa.pre_state, 'null'::jsonb) as pre_state,
    coalesce(aa.post_state, 'null'::jsonb) as post_state,
    aa.created_at,
    coalesce(aa.actor_user_id, 'system') as actor,
    aa.outcome = 'succeeded'::action_outcome
      and aa.undo_of is null
      and aa.created_at > (now() - '24:00:00'::interval)
      and not (exists (select 1 from action_audit u where u.undo_of = aa.id)) as undo_eligible,
    aa.alert_id,
    coalesce(al.detector_id, '') as detector_id,
    aa.last_error as failure_reason,
    aa.undo_of,
    aa.trigger_reason,
    aa.params ->> 'sku_id' as param_sku_id,
    aa.params ->> 'platform' as param_platform
  from action_audit aa
  left join alerts al on al.id = aa.alert_id
  order by aa.created_at desc;

alter view public.v_audit_view set (security_invoker = on);
```

- [ ] **Step 2: Validate the DDL compiles (rollback, no persistence)**

Run via the Supabase MCP `execute_sql` against project `ajgrmnvzxfxxlwrxcgnu`, wrapping the whole migration body in `begin; … rollback;`. Expected: no error (rolls back, proving the SQL is valid).

- [ ] **Step 3: Apply the migration**

Apply via the Supabase MCP `apply_migration` (name `action_audit_trigger_reason`, the SQL above). Expected: success.

- [ ] **Step 4: Verify the new columns are queryable**

Run `select trigger_reason, param_sku_id, param_platform from public.v_audit_view limit 1;` via `execute_sql`. Expected: returns (values may be null), no error.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260615T130000_action_audit_trigger_reason.sql
git commit -m "supabase: action_audit.trigger_reason + v_audit_view exposes it and lineage params"
```

---

## Task 2: `CostSource` type + `AuditEntry` fields

**Files:**
- Modify: `app/lib/types.ts` (the `AuditEntry` interface, ~line 43-61)

- [ ] **Step 1: Add the `CostSource` type and the two `AuditEntry` fields**

Add this type just above `AuditEntry`:

```ts
/** One input that fed an action's booked-margin figure, with its data source.
 *  `kind` is what the input is; `source` is the connected system it came from.
 *  source ∈ "quickbooks" | "vendor_invoice" | "shopify" | "meta" | "google" |
 *  "tiktok" | "unavailable" (when a margin action's COGS source couldn't be resolved). */
export interface CostSource {
  kind: "cogs" | "price" | "ad_spend";
  source: string;
}
```

Add these two fields inside `AuditEntry` (after `undo_of?`):

```ts
  /** Plain-language reason the autopilot recorded at the decision point.
   *  Null/absent on manual rows — the "why" is derived from the alert instead. */
  trigger_reason?: string | null;
  /** Booked-margin cost-data lineage, resolved server-side in audit.list.
   *  Empty for actions with no margin inputs (snooze, resume). */
  cost_sources?: CostSource[];
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: exit 0 (new optional fields break nothing).

- [ ] **Step 3: Commit**

```bash
git add app/lib/types.ts
git commit -m "lib/types: CostSource + AuditEntry trigger_reason/cost_sources"
```

---

## Task 3: Labels — actor normalization + basis/source labels

**Files:**
- Modify: `app/lib/labels.ts` (the `ACTOR_LABELS`/`actorLabel`, ~line 63-71)
- Create: `app/lib/__tests__/labels-actor.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/__tests__/labels-actor.test.ts
import { describe, it, expect } from "vitest";
import { actorLabel, MARGIN_BASIS_LABELS, COST_SOURCE_LABELS } from "../labels";

describe("actorLabel normalization", () => {
  it("maps known internal actors to merchant language", () => {
    expect(actorLabel("merchant")).toBe("You");
    expect(actorLabel("autopilot")).toBe("Autopilot");
    expect(actorLabel("system")).toBe("System");
  });
  it("normalizes the web-dashboard suffix", () => {
    expect(actorLabel("merchant:web-dashboard")).toBe("You (dashboard)");
  });
  it("passes an unknown teammate email through unchanged", () => {
    expect(actorLabel("jane@store.com")).toBe("jane@store.com");
  });
});

describe("margin-basis + cost-source labels", () => {
  it("labels each margin basis", () => {
    expect(MARGIN_BASIS_LABELS.measured).toBe("Measured from budget change");
    expect(MARGIN_BASIS_LABELS.alert_estimate).toBe("Estimated from alert (at-stake)");
    expect(MARGIN_BASIS_LABELS.snapshot).toBe("Estimate snapshot");
    expect(MARGIN_BASIS_LABELS.none).toBe("No booked margin");
  });
  it("labels each cost source", () => {
    expect(COST_SOURCE_LABELS.quickbooks).toBe("QuickBooks");
    expect(COST_SOURCE_LABELS.vendor_invoice).toBe("Vendor invoice");
    expect(COST_SOURCE_LABELS.shopify).toBe("Shopify");
    expect(COST_SOURCE_LABELS.meta).toBe("Meta");
    expect(COST_SOURCE_LABELS.unavailable).toBe("source unavailable");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/__tests__/labels-actor.test.ts`
Expected: FAIL — `MARGIN_BASIS_LABELS`/`COST_SOURCE_LABELS` not exported, `merchant:web-dashboard` returns raw.

- [ ] **Step 3: Implement**

Replace the `ACTOR_LABELS` block + `actorLabel` (lines ~63-71) with:

```ts
export const ACTOR_LABELS: Record<string, string> = {
  merchant: "You",
  "merchant:web-dashboard": "You (dashboard)",
  autopilot: "Autopilot",
  system: "System",
};

export function actorLabel(actor: string): string {
  return ACTOR_LABELS[actor] ?? actor;
}

// Provenance of an audit row's booked-margin figure (see audit-legibility.ts).
export const MARGIN_BASIS_LABELS: Record<string, string> = {
  measured: "Measured from budget change",
  alert_estimate: "Estimated from alert (at-stake)",
  snapshot: "Estimate snapshot",
  none: "No booked margin",
};

// Connected systems a booked-margin input can come from.
export const COST_SOURCE_LABELS: Record<string, string> = {
  quickbooks: "QuickBooks",
  vendor_invoice: "Vendor invoice",
  shopify: "Shopify",
  meta: "Meta",
  google: "Google",
  tiktok: "TikTok",
  unavailable: "source unavailable",
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/__tests__/labels-actor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/labels.ts app/lib/__tests__/labels-actor.test.ts
git commit -m "lib/labels: normalize web-dashboard actor; add margin-basis + cost-source labels"
```

---

## Task 4: The shared `audit-legibility.ts` module

**Files:**
- Create: `app/lib/audit-legibility.ts`
- Create: `app/lib/__tests__/audit-legibility.test.ts`

This module is PURE (no `.server` imports) so the client-only dashboard bundle can import it. It imports only `./types` and `./labels`.

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/__tests__/audit-legibility.test.ts
import { describe, it, expect } from "vitest";
import { auditLegibility } from "../audit-legibility";
import type { AuditEntry } from "../types";

function row(over: Partial<AuditEntry>): AuditEntry {
  return {
    id: "a1", action_kind: "pause_campaign", outcome: "succeeded", target: "Meta Summer",
    dollar_impact_at_exec: 0, pre_state: null, post_state: null, created_at: "2026-06-15T00:00:00Z",
    actor: "merchant", undo_eligible: true, alert_id: null, detector_id: "campaign_below_breakeven",
    ...over,
  } as AuditEntry;
}

describe("auditLegibility — mode", () => {
  it("autopilot actor → auto", () => {
    expect(auditLegibility(row({ actor: "autopilot" })).mode).toBe("auto");
  });
  it("merchant / dashboard / email → manual", () => {
    expect(auditLegibility(row({ actor: "merchant" })).mode).toBe("manual");
    expect(auditLegibility(row({ actor: "merchant:web-dashboard" })).mode).toBe("manual");
    expect(auditLegibility(row({ actor: "jane@store.com" })).mode).toBe("manual");
  });
  it("actorDisplay is normalized", () => {
    expect(auditLegibility(row({ actor: "merchant:web-dashboard" })).actorDisplay).toBe("You (dashboard)");
    expect(auditLegibility(row({ actor: "autopilot" })).actorDisplay).toBe("Autopilot");
  });
});

describe("auditLegibility — marginBasis (provenance)", () => {
  it("alert-attributed value action → alert_estimate", () => {
    const l = auditLegibility(row({ action_kind: "create_po_draft", alert_id: "al1", dollar_impact_at_exec: 466885 }));
    expect(l.marginBasis).toBe("alert_estimate");
    expect(l.marginBasisLabel).toBe("Estimated from alert (at-stake)");
  });
  it("no-alert budget action with pre/post → measured", () => {
    const l = auditLegibility(row({
      action_kind: "reduce_campaign_budget", alert_id: null, dollar_impact_at_exec: 100,
      pre_state: { daily_budget_cents: 1000 }, post_state: { daily_budget_cents: 900 },
    }));
    expect(l.marginBasis).toBe("measured");
  });
  it("zero-impact non-recovering action (snooze) → none", () => {
    const l = auditLegibility(row({ action_kind: "snooze_alert", alert_id: "al1", dollar_impact_at_exec: 0 }));
    expect(l.marginBasis).toBe("none");
  });
  it("zero impact but estimate snapshot present → snapshot", () => {
    const l = auditLegibility(row({
      action_kind: "create_po_draft", alert_id: null, dollar_impact_at_exec: 0,
      post_state: { estimate_cents: 466885 },
    }));
    expect(l.marginBasis).toBe("snapshot");
  });
});

describe("auditLegibility — costLineage", () => {
  it("passes through resolved cost_sources", () => {
    const sources = [{ kind: "cogs" as const, source: "quickbooks" }, { kind: "price" as const, source: "shopify" }];
    expect(auditLegibility(row({ action_kind: "create_po_draft", cost_sources: sources })).costLineage).toEqual(sources);
  });
  it("empty when none resolved", () => {
    expect(auditLegibility(row({ action_kind: "snooze_alert" })).costLineage).toEqual([]);
  });
});

describe("auditLegibility — why", () => {
  it("autopilot prefers the persisted trigger_reason", () => {
    const l = auditLegibility(row({ actor: "autopilot", trigger_reason: "Auto-pause: 'Campaign is losing money' — $420 at stake" }));
    expect(l.why).toContain("Auto-pause");
    expect(l.whyDetail).toContain("$420 at stake");
  });
  it("autopilot without trigger_reason falls back to the detector rule", () => {
    const l = auditLegibility(row({ actor: "autopilot", detector_id: "campaign_below_breakeven", trigger_reason: null }));
    expect(l.why).toBe("Autopilot — Campaign is losing money");
  });
  it("manual with alert → resolved-detector", () => {
    const l = auditLegibility(row({ actor: "merchant", alert_id: "al1", detector_id: "campaign_below_breakeven" }));
    expect(l.why).toBe("Resolved: Campaign is losing money");
  });
  it("manual no-alert from the dashboard → manual-surface", () => {
    const l = auditLegibility(row({ actor: "merchant:web-dashboard", alert_id: null }));
    expect(l.why).toBe("Manual — dashboard");
  });
  it("undo row → reversal", () => {
    const l = auditLegibility(row({ undo_of: "00000000-1111-2222-3333-444444444444" }));
    expect(l.why).toContain("Reversal of");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/__tests__/audit-legibility.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the module**

```ts
// app/lib/audit-legibility.ts
//
// Single shared "brain" for the audit log. Turns an enriched AuditEntry into a
// display-ready AuditLegibility consumed by BOTH surfaces: the Polaris extension
// (app/routes/app.audit.tsx) and the dashboard (via adaptAudit). Parity by
// construction — match the contract, render natively on each side.
//
// PURE: imports only ./types and ./labels. Never import a *.server module here;
// the client-only dashboard bundle imports this file.

import type { ActionKind, AuditEntry, CostSource } from "./types";
import { DETECTOR_LABELS, MARGIN_BASIS_LABELS, actorLabel } from "./labels";

export type ActionMode = "auto" | "manual";
export type MarginBasis = "measured" | "alert_estimate" | "snapshot" | "none";

export interface AuditLegibility {
  mode: ActionMode;
  actorDisplay: string;
  marginBasis: MarginBasis;
  marginBasisLabel: string;
  costLineage: CostSource[];
  why: string;
  whyDetail?: string;
}

// Actions whose booked figure is ad-spend dollars stopped — lineage is the ad
// platform. (Mirrors VALUE_RECOVERING budget kinds in audit-impact.ts.)
export const AD_SPEND_ACTIONS: ReadonlySet<ActionKind> = new Set<ActionKind>([
  "pause_campaign", "reduce_campaign_budget", "reallocate_budget", "exclude_geo",
]);
// Actions whose booked figure involves unit margin (price − COGS) — lineage is
// the COGS source (+ Shopify price). Used server-side to resolve cost_sources.
export const MARGIN_ACTIONS: ReadonlySet<ActionKind> = new Set<ActionKind>([
  "create_po_draft", "reallocate_inventory",
]);
// Actions that recover value (so a 0 figure is unexpected, not "none"). Mirrors
// audit-impact.ts VALUE_RECOVERING exactly — keep in sync.
const VALUE_RECOVERING: ReadonlySet<ActionKind> = new Set<ActionKind>([
  "pause_campaign", "reduce_campaign_budget", "reallocate_budget",
  "exclude_geo", "reallocate_inventory", "create_po_draft",
]);

function hasBudgetStates(e: AuditEntry): boolean {
  const pre = e.pre_state as Record<string, unknown> | null;
  const post = e.post_state as Record<string, unknown> | null;
  const n = (o: Record<string, unknown> | null, k: string) => o && typeof o[k] === "number";
  // plain budget states (pause/reduce) or reallocate's {source:{...}} shape
  return Boolean(
    n(pre, "daily_budget_cents") || n(post, "daily_budget_cents") ||
    n((pre?.source ?? null) as Record<string, unknown> | null, "daily_budget_cents"),
  );
}

function estimateSnapshot(e: AuditEntry): boolean {
  const post = e.post_state as Record<string, unknown> | null;
  const pre = e.pre_state as Record<string, unknown> | null;
  return typeof (post?.estimate_cents ?? pre?.estimate_cents) === "number";
}

/** Provenance of dollar_impact_at_exec, derived from the SAME inputs the figure
 *  was computed from (insertAuditWithIdempotency): alert_id → at-stake estimate;
 *  else budget pre/post delta → measured; else estimate snapshot; else none. */
export function marginBasisFor(e: AuditEntry): MarginBasis {
  const recovering = VALUE_RECOVERING.has(e.action_kind);
  if (!recovering && (e.dollar_impact_at_exec ?? 0) === 0) return "none";
  if (e.alert_id) return "alert_estimate";
  if (hasBudgetStates(e)) return "measured";
  if (estimateSnapshot(e)) return "snapshot";
  return "none";
}

function deriveWhy(e: AuditEntry, mode: ActionMode): { why: string; whyDetail?: string } {
  if (e.undo_of) return { why: `Reversal of ${e.undo_of.slice(0, 8)}`, whyDetail: undefined };
  const detector = DETECTOR_LABELS[e.detector_id] ?? "";
  if (mode === "auto") {
    if (e.trigger_reason) {
      const r = e.trigger_reason;
      return { why: r.length > 64 ? `${r.slice(0, 61)}…` : r, whyDetail: r };
    }
    return { why: detector ? `Autopilot — ${detector}` : "Autopilot", whyDetail: detector || undefined };
  }
  if (e.alert_id && detector) return { why: `Resolved: ${detector}`, whyDetail: detector };
  const surface = e.actor === "merchant:web-dashboard" ? "dashboard" : "campaigns page";
  return { why: `Manual — ${surface}`, whyDetail: undefined };
}

export function auditLegibility(e: AuditEntry): AuditLegibility {
  const mode: ActionMode = e.actor.startsWith("autopilot") ? "auto" : "manual";
  const basis = marginBasisFor(e);
  const { why, whyDetail } = deriveWhy(e, mode);
  return {
    mode,
    actorDisplay: actorLabel(e.actor),
    marginBasis: basis,
    marginBasisLabel: MARGIN_BASIS_LABELS[basis],
    costLineage: e.cost_sources ?? [],
    why,
    whyDetail,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/__tests__/audit-legibility.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Anti-drift test — basis matches what audit-impact used**

Append to the test file:

```ts
import { recoveredCentsFromStates } from "../audit-impact";

describe("marginBasis anti-drift", () => {
  it("a no-alert budget action that audit-impact measures from states reports 'measured'", () => {
    const pre = { daily_budget_cents: 1000 };
    const post = { daily_budget_cents: 900 };
    // audit-impact would derive a positive figure from these states (no alert)…
    expect(recoveredCentsFromStates("reduce_campaign_budget", pre, post)).toBeGreaterThan(0);
    // …so the basis must be 'measured', not 'alert_estimate'.
    const l = auditLegibility(row({
      action_kind: "reduce_campaign_budget", alert_id: null, dollar_impact_at_exec: 100, pre_state: pre, post_state: post,
    }));
    expect(l.marginBasis).toBe("measured");
  });
});
```

Run: `npx vitest run app/lib/__tests__/audit-legibility.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/lib/audit-legibility.ts app/lib/__tests__/audit-legibility.test.ts
git commit -m "lib/audit-legibility: shared mode/margin-basis/lineage/why derivation for both surfaces"
```

---

## Task 5: Thread `triggerReason` through the executors

**Files:**
- Modify: `app/lib/actions/execute.server.ts` (`ExecuteInput` ~line 16-23, `AuditInsert` ~line 99-108, the audit insert in `executeAction` ~line 254-269)
- Modify: `app/lib/actions/reallocate.server.ts` (`ReallocateInput` ~line 20-27, the insert ~line 178-192)

- [ ] **Step 1: Add `triggerReason` to `ExecuteInput` and `AuditInsert`**

In `execute.server.ts`, add to `ExecuteInput` (after `actor?`):
```ts
  /** Plain-language reason persisted to action_audit.trigger_reason. Autopilot
   *  sets it; manual paths leave it undefined. */
  triggerReason?: string;
```
Add to `AuditInsert` (after `actor_user_id`):
```ts
  trigger_reason?: string | null;
```

- [ ] **Step 2: Persist it in `insertAuditWithIdempotency`**

In the `.insert({ … })` object (~line 134), the spread `...audit` already carries `trigger_reason` once it's on `AuditInsert`. Confirm the column name matches (`trigger_reason`). No other change needed — the spread handles it. (If `audit.trigger_reason` is `undefined`, Postgres receives no value → null. Good.)

- [ ] **Step 3: Pass it from `executeAction`**

In the `insertAuditWithIdempotency` call at the end of `executeAction` (~line 256-268), add to the audit object (after `actor_user_id`):
```ts
      trigger_reason: input.triggerReason ?? null,
```

- [ ] **Step 4: Add `triggerReason` to `ReallocateInput` and its insert**

In `reallocate.server.ts`, add to `ReallocateInput` (after `actor?`):
```ts
  triggerReason?: string;
```
In the `insertAuditWithIdempotency` call (~line 181-190), add (after `actor_user_id`):
```ts
      trigger_reason: input.triggerReason ?? null,
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add app/lib/actions/execute.server.ts app/lib/actions/reallocate.server.ts
git commit -m "lib/actions: thread triggerReason into the audit row (executeAction + reallocate)"
```

---

## Task 6: Autopilot writes a plain-language reason

**Files:**
- Modify: `app/lib/actions/autopilot.server.ts` (the loop body, ~line 57-171)
- Modify: `app/lib/actions/__tests__/autopilot.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `autopilot.test.ts` a case asserting the reason reaches the executor. The existing tests stub `executeAction`/`executeReallocation`; capture the input. Add:

```ts
it("records a plain-language trigger_reason on the autopilot action", async () => {
  // (Reuse the file's existing harness that mocks guardrails as allowed and a
  // single pause candidate for detector campaign_below_breakeven.)
  const calls = captureExecuteActionCalls(); // existing helper / spy in this file
  await runAutopilotForShop("shop-1", fakeSb);
  expect(calls[0].triggerReason).toContain("Auto-pause");
  expect(calls[0].triggerReason).toContain("Campaign is losing money");
});
```

> If the file lacks a reusable spy, assert against the `executeAction` mock's recorded argument (`expect(executeAction).toHaveBeenCalledWith("shop-1", expect.objectContaining({ triggerReason: expect.stringContaining("Auto-pause") }), fakeSb)`). Match the file's existing mocking style.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/actions/__tests__/autopilot.test.ts`
Expected: FAIL — `triggerReason` is undefined on the call.

- [ ] **Step 3: Implement — build and pass the reason**

At the top of `autopilot.server.ts`, import the detector labels:
```ts
import { DETECTOR_LABELS } from "../labels";
```
Add a helper above `runAutopilotForShop`:
```ts
function autopilotReason(verb: string, detectorId: string, dollarImpact: number): string {
  const label = DETECTOR_LABELS[detectorId as keyof typeof DETECTOR_LABELS] ?? detectorId;
  const stake = Math.round(Number(dollarImpact) || 0).toLocaleString("en-US");
  return `${verb}: "${label}" — $${stake} at stake, within guardrails`;
}
```
In the reallocation `executeReallocation` call (~line 124-135), add to the input object:
```ts
              triggerReason: autopilotReason("Auto reallocate budget", c.detector_id, c.dollar_impact),
```
In the final `executeAction` call (~line 159-169), add:
```ts
        triggerReason: autopilotReason(
          kind === "pause_campaign" ? "Auto-pause" : "Auto budget cut",
          c.detector_id,
          c.dollar_impact,
        ),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/actions/__tests__/autopilot.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/actions/autopilot.server.ts app/lib/actions/__tests__/autopilot.test.ts
git commit -m "lib/actions/autopilot: record a plain-language trigger_reason for every auto action"
```

---

## Task 7: `calderyn.server.ts` — read `trigger_reason`, resolve `cost_sources`

**Files:**
- Modify: `app/lib/calderyn.server.ts` (`rowToAudit` ~line 125-142, `audit.list` ~line 311-325)

- [ ] **Step 1: `rowToAudit` reads `trigger_reason`**

In `rowToAudit`, add (after `undo_of`):
```ts
    trigger_reason: (r.trigger_reason as string | null) ?? null,
    cost_sources: (r.cost_sources as AuditEntry["cost_sources"]) ?? [],
```
(`cost_sources` is attached to the row object by `audit.list` before calling `rowToAudit`; default `[]` keeps the undo/get paths that call `rowToAudit` on a raw view row safe.)

- [ ] **Step 2: Import the action-class sets + CostSource**

At the top of `calderyn.server.ts`, add to the relevant imports:
```ts
import { AD_SPEND_ACTIONS, MARGIN_ACTIONS } from "./audit-legibility";
import type { CostSource } from "./types";
```

- [ ] **Step 3: Resolve lineage in `audit.list`**

Replace the body of `audit.list` (~line 311-324) with:

```ts
      async list(_signal?: AbortSignal): Promise<AuditEntry[]> {
        try {
          const shopId = await shopIdP;
          const { data, error } = await supabase
            .from("v_audit_view")
            .select("*")
            .eq("shop_id", shopId)
            .order("created_at", { ascending: false })
            .limit(100);
          if (error) throw error;
          const rows = data ?? [];

          // One batched COGS-source lookup for every margin-action sku on the page.
          const skuIds = Array.from(
            new Set(
              rows
                .filter((r) => MARGIN_ACTIONS.has(String(r.action_kind) as never) && r.param_sku_id)
                .map((r) => String(r.param_sku_id)),
            ),
          );
          let cogsBySku = new Map<string, string>();
          if (skuIds.length > 0) {
            try {
              const { data: costs, error: cErr } = await supabase
                .from("sku_cost_history")
                .select("sku_id, source, effective_from")
                .in("sku_id", skuIds);
              if (cErr) throw cErr;
              // Keep the latest-effective source per sku.
              const latest = new Map<string, string>();
              for (const c of costs ?? []) {
                const k = String(c.sku_id);
                const prev = latest.get(k);
                if (!prev || String(c.effective_from) > prev) latest.set(k, String(c.effective_from));
              }
              for (const c of costs ?? []) {
                const k = String(c.sku_id);
                if (latest.get(k) === String(c.effective_from)) cogsBySku.set(k, String(c.source));
              }
            } catch (err) {
              // Fail visibly (rule 12): the log still loads; margin rows show
              // "source unavailable" instead of blanking the whole audit page.
              console.error(`[audit] cost-source lookup failed for shop ${shopId}`, err);
              cogsBySku = new Map();
            }
          }

          return rows.map((r) => {
            const kind = String(r.action_kind);
            const cost_sources: CostSource[] = [];
            if (AD_SPEND_ACTIONS.has(kind as never) && r.param_platform) {
              cost_sources.push({ kind: "ad_spend", source: String(r.param_platform) });
            } else if (MARGIN_ACTIONS.has(kind as never)) {
              cost_sources.push({ kind: "price", source: "shopify" });
              const skuId = r.param_sku_id ? String(r.param_sku_id) : "";
              cost_sources.push({ kind: "cogs", source: cogsBySku.get(skuId) ?? "unavailable" });
            }
            return rowToAudit({ ...r, cost_sources });
          });
        } catch (err) {
          rethrow("audit.list", err);
        }
      },
```

- [ ] **Step 4: Typecheck + existing calderyn tests**

Run: `npm run typecheck`
Expected: exit 0.
Run: `npx vitest run app/lib/__tests__/calderyn-shop-scope.test.ts`
Expected: PASS (no regression in the audit path).

- [ ] **Step 5: Commit**

```bash
git add app/lib/calderyn.server.ts
git commit -m "lib/calderyn.server: read trigger_reason; resolve booked-margin cost lineage in audit.list"
```

---

## Task 8: Dashboard view-model + `adaptAudit`

**Files:**
- Modify: `app/components/dashboard/view-models.ts` (`AuditVM` ~line 49-67)
- Modify: `app/lib/dashboard/client.ts` (`adaptAudit` ~line 254-273)
- Modify: `app/lib/dashboard/__tests__/adapt-audit.test.ts`

- [ ] **Step 1: Extend `AuditVM`**

Add to `AuditVM` (after `failure?`):
```ts
  /** Legibility signals derived once in audit-legibility.ts (parity with the
   *  extension). Rendered in the dashboard's own primitives. */
  mode: "auto" | "manual";
  actorDisplay: string;
  marginBasis: string;
  marginBasisLabel: string;
  costLineage: import("~/lib/types").CostSource[];
  why: string;
  whyDetail?: string;
```

- [ ] **Step 2: Write the failing test**

Add to `adapt-audit.test.ts`:

```ts
it("carries the legibility signals (parity with the extension)", () => {
  const vm = adaptAudit({
    id: "a1", action_kind: "pause_campaign", outcome: "succeeded", target: "Meta Summer",
    dollar_impact_at_exec: 100, pre_state: { daily_budget_cents: 1000 }, post_state: { daily_budget_cents: 0 },
    created_at: "2026-06-15T00:00:00Z", actor: "autopilot", undo_eligible: false, alert_id: "al1",
    detector_id: "campaign_below_breakeven",
    trigger_reason: 'Auto-pause: "Campaign is losing money" — $420 at stake, within guardrails',
    cost_sources: [{ kind: "ad_spend", source: "meta" }],
  });
  expect(vm.mode).toBe("auto");
  expect(vm.actorDisplay).toBe("Autopilot");
  expect(vm.marginBasis).toBe("alert_estimate");
  expect(vm.costLineage).toEqual([{ kind: "ad_spend", source: "meta" }]);
  expect(vm.why).toContain("Auto-pause");
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run app/lib/dashboard/__tests__/adapt-audit.test.ts`
Expected: FAIL — `vm.mode` undefined.

- [ ] **Step 4: Implement — call `auditLegibility` in `adaptAudit`**

At the top of `client.ts` add the import (this module is pure, safe for the client bundle):
```ts
import { auditLegibility } from "~/lib/audit-legibility";
```
In `adaptAudit`, build the legibility object and spread its fields into the return:
```ts
export function adaptAudit(e: AuditEntry): AuditVM {
  const leg = auditLegibility(e);
  return {
    id: e.id,
    action_kind: e.action_kind,
    verb: AUDIT_VERBS[e.action_kind] ?? e.action_kind,
    target: e.target,
    detail: e.failure_reason ?? "",
    dollar_impact_at_exec: e.dollar_impact_at_exec,
    outcome: e.outcome,
    actor: e.actor,
    when: e.created_at,
    created_at: e.created_at,
    undo_eligible: e.undo_eligible,
    undo_of: e.undo_of ?? null,
    pre: summarizeState(e.pre_state),
    post: summarizeState(e.post_state),
    failure: e.failure_reason,
    mode: leg.mode,
    actorDisplay: leg.actorDisplay,
    marginBasis: leg.marginBasis,
    marginBasisLabel: leg.marginBasisLabel,
    costLineage: leg.costLineage,
    why: leg.why,
    whyDetail: leg.whyDetail,
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run app/lib/dashboard/__tests__/adapt-audit.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/components/dashboard/view-models.ts app/lib/dashboard/client.ts app/lib/dashboard/__tests__/adapt-audit.test.ts
git commit -m "dashboard: adaptAudit emits shared legibility signals on AuditVM"
```

---

## Task 9: Dashboard icon — `chevronDown`

**Files:**
- Modify: `app/components/dashboard/icons.tsx`

- [ ] **Step 1: Add the icon (per the registry convention — one import + one line)**

Add `ChevronDown` to the existing `lucide-react` import, and add to `CD_ICONS` (next to `chevronRight`):
```ts
  chevronDown: ChevronDown,
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add app/components/dashboard/icons.tsx
git commit -m "dashboard/icons: add chevronDown for the expandable audit row"
```

---

## Task 10: Dashboard `Audit.tsx` — expandable rows + signals

**Files:**
- Modify: `app/components/dashboard/screens/Audit.tsx`

- [ ] **Step 1: Make `AuditRow` expandable with the inline signals**

Replace the `AuditRow` component with the version below. Changes: a clickable chevron toggling a `Collapsible`-style detail block; an Auto/Manual `Pill` (tone from `entry.mode`, fixing the old dead `=== "Autopilot"` check); a margin-source caption under the `+$` figure; a why-caption under the title; and a detail panel rendering Why / Booked margin / Cost lineage.

```tsx
import { useState, type ReactNode } from "react";
import { Card, Pill, Btn, Placeholder } from "../ui";
import { CDIcon, CD_ACTION_ICON } from "../icons";
import { money, timeAgo, absTime } from "../format";
import { COST_SOURCE_LABELS } from "~/lib/labels";
import { recovered } from "~/lib/recovered";
import type { DashboardCtx } from "../context";
import type { AuditVM } from "../view-models";

function AuditRow({ entry, app }: { entry: AuditVM; app: DashboardCtx }) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const failed = entry.outcome === "failed";
  const retrying = entry.outcome === "retrying";
  const undone =
    Boolean((entry as AuditVM & { undone?: boolean }).undone) || entry.post === "Reverted";

  const onUndo = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await app.undoAction(entry);
    } finally {
      setBusy(false);
    }
  };

  const tone = failed ? "critical" : entry.mode === "auto" ? "accent" : "success";
  const iconName = failed ? "warn" : CD_ACTION_ICON[entry.action_kind] ?? "bolt";
  const showImpact = entry.dollar_impact_at_exec > 0 && !undone;

  return (
    <div className="cd-row" data-dim={failed ? "1" : "0"} style={{ flexWrap: "wrap" }}>
      <button
        className="cd-feed-icon"
        data-tone={tone}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={open ? "Hide details" : "Show details"}
        style={{ border: 0, cursor: "pointer", background: "transparent" }}
      >
        <CDIcon name={open ? "chevronDown" : "chevronRight"} size={14} strokeWidth={1.9} />
      </button>
      <span className="cd-feed-icon" data-tone={tone}>
        <CDIcon name={iconName} size={14} strokeWidth={1.9} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Pill tone={entry.mode === "auto" ? "accent" : "neutral"}>
            {entry.mode === "auto" ? "Auto" : "Manual"}
          </Pill>
          <span className="cd-row-title truncate">
            {entry.undo_of ? "Reversed — " : ""}
            {entry.verb} — {entry.target}
          </span>
          {failed && <Pill tone="critical" icon="x">Blocked</Pill>}
          {retrying && <Pill tone="warn" icon="clock">Retrying</Pill>}
          {undone && <Pill icon="undo">Undone</Pill>}
        </div>
        <div className="cd-caption truncate">{entry.why}</div>
      </div>
      <div className="text-right whitespace-nowrap">
        {showImpact && (
          <div className="cd-row-num tabular-nums" style={{ color: "var(--green)" }}>
            +{money(entry.dollar_impact_at_exec)}
          </div>
        )}
        {showImpact && <div className="cd-caption">{entry.marginBasisLabel}</div>}
        <div className="cd-caption" title={absTime(entry.when) || undefined}>
          {entry.actorDisplay} · {timeAgo(entry.when)}
        </div>
      </div>
      {entry.undo_eligible && !undone && (
        <Btn small icon="undo" disabled={busy} onClick={onUndo}>
          {busy ? "Undoing…" : "Undo"}
        </Btn>
      )}
      {open && (
        <div className="cd-audit-detail" style={{ flexBasis: "100%", paddingLeft: 32, paddingTop: 8 }}>
          <DetailBlock label="Why this fired">{entry.whyDetail ?? entry.why}</DetailBlock>
          {showImpact && (
            <DetailBlock label="Booked margin">
              +{money(entry.dollar_impact_at_exec)} · {entry.marginBasisLabel}
            </DetailBlock>
          )}
          {entry.costLineage.length > 0 && (
            <DetailBlock label="Cost lineage">
              <span className="flex items-center gap-1" style={{ flexWrap: "wrap" }}>
                {entry.costLineage.map((s, i) => (
                  <Pill key={i} tone={s.source === "unavailable" ? "warn" : "neutral"}>
                    {s.kind === "ad_spend" ? "Ad spend" : s.kind === "cogs" ? "COGS" : "Price"}:{" "}
                    {COST_SOURCE_LABELS[s.source] ?? s.source}
                  </Pill>
                ))}
              </span>
            </DetailBlock>
          )}
          {entry.pre !== "—" && (
            <DetailBlock label="Before → after">
              {entry.pre} → {entry.post}
            </DetailBlock>
          )}
        </div>
      )}
    </div>
  );
}

function DetailBlock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 6 }}>
      <span className="cd-caption" style={{ fontWeight: 600 }}>{label}: </span>
      <span className="cd-caption">{children}</span>
    </div>
  );
}
```

> Keep the existing `ScreenHeader` and default-export `Audit` component below unchanged (they already pass `entry`/`app` to `AuditRow`).

- [ ] **Step 2: Typecheck + lint the touched file**

Run: `npm run typecheck`
Expected: exit 0.
Run: `npx eslint app/components/dashboard/screens/Audit.tsx --max-warnings=0`
Expected: clean.

- [ ] **Step 3: Update the existing screen test if needed**

Run: `npx vitest run app/components/dashboard/screens/__tests__/audit-recovered.test.ts`
Expected: PASS (it tests the `recovered` total, not row internals; if it asserts a removed prop, update it to the new VM shape).

- [ ] **Step 4: Commit**

```bash
git add app/components/dashboard/screens/Audit.tsx
git commit -m "dashboard/Audit: expandable rows with Auto/Manual pill, margin-source + why captions, cost lineage"
```

---

## Task 11: Extension `app.audit.tsx` — IndexTable + expandable detail

**Files:**
- Modify: `app/routes/app.audit.tsx`

The Polaris `DataTable` can't expand rows; switch to `IndexTable` (App-Store-blessed) with a clickable row that toggles a full-width detail row via `Collapsible`. Inline cells gain an Auto/Manual `Badge`, a margin-source caption under Impact, and a why caption under Action. Undo + Download PDF stay inline.

- [ ] **Step 1: Swap imports**

In the Polaris import block, add `IndexTable`, `Collapsible`, `Icon` and remove `DataTable`:
```ts
import {
  Badge, Banner, BlockStack, Box, Button, Card, Collapsible, Icon, IndexTable,
  InlineGrid, InlineStack, Page, Text, Tooltip,
} from "@shopify/polaris";
import { ChevronDownIcon, ChevronRightIcon } from "@shopify/polaris-icons";
```
Add the shared helpers:
```ts
import { auditLegibility } from "~/lib/audit-legibility";
import { COST_SOURCE_LABELS } from "~/lib/labels";
```

- [ ] **Step 2: Replace the `rows`/`DataTable` rendering with an `IndexTable` of expandable rows**

Replace the `const rows = audit.map(…)` block AND the `<Card padding="0"><DataTable …/></Card>` with a row component and `IndexTable`. Add this component above `export default function Audit()`:

```tsx
function AuditRowEx({
  a, index, submitting,
}: { a: AuditEntry; index: number; submitting: boolean }) {
  const [open, setOpen] = useState(false);
  const leg = auditLegibility(a);
  const actionLabel = ACTION_LABELS[a.action_kind] ?? a.action_kind;
  const canUndo = a.undo_eligible && !a.undo_of;
  const hasPoPdf =
    a.action_kind === "create_po_draft" && a.outcome === "succeeded" && Boolean(a.post_state?.po);
  const estimateCents = Number(a.post_state?.estimate_cents ?? 0);
  const showEstimate =
    !a.dollar_impact_at_exec && estimateCents > 0 && a.action_kind !== "snooze_alert";
  const showImpact = Boolean(a.dollar_impact_at_exec);

  return (
    <>
      <IndexTable.Row id={a.id} position={index}>
        <IndexTable.Cell>
          <Button
            variant="tertiary"
            icon={open ? ChevronDownIcon : ChevronRightIcon}
            onClick={() => setOpen((v) => !v)}
            accessibilityLabel={open ? "Hide details" : "Show details"}
          />
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Tooltip content={fmtAbsTime(a.created_at)}>
            <Text as="span" variant="bodySm" fontWeight="semibold">{fmtRelTime(a.created_at)}</Text>
          </Tooltip>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <BlockStack gap="050">
            <Text as="p" variant="bodySm" fontWeight="semibold">
              {a.undo_of ? `Reversed — ${actionLabel}` : actionLabel}
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">{leg.why}</Text>
          </BlockStack>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Badge tone={leg.mode === "auto" ? "info" : undefined}>
            {leg.mode === "auto" ? "Auto" : "Manual"}
          </Badge>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Tooltip content={a.target}><Text as="span" variant="bodySm">{shortId(a.target)}</Text></Tooltip>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <BlockStack gap="050" inlineAlign="end">
            <Text as="p" alignment="end" variant="bodySm" fontWeight="semibold">
              {a.dollar_impact_at_exec < 0 ? "-" : ""}{fmtMoney(Math.abs(a.dollar_impact_at_exec || 0))}
            </Text>
            {showImpact && <Text as="p" alignment="end" variant="bodySm" tone="subdued">{leg.marginBasisLabel}</Text>}
            {showEstimate && <Text as="p" alignment="end" variant="bodySm" tone="subdued">est. {fmtMoney(estimateCents)}</Text>}
          </BlockStack>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Badge tone={a.outcome === "succeeded" ? "success" : a.outcome === "retrying" ? "attention" : "critical"}>
            {a.outcome}
          </Badge>
        </IndexTable.Cell>
        <IndexTable.Cell>
          {canUndo || hasPoPdf ? (
            <InlineStack gap="200" wrap={false}>
              {canUndo && (
                <Form method="post">
                  <input type="hidden" name="intent" value="undo" />
                  <input type="hidden" name="auditId" value={a.id} />
                  <Button submit variant="plain" loading={submitting} disabled={submitting}>Undo</Button>
                </Form>
              )}
              {hasPoPdf && <DownloadPoButton auditId={a.id} />}
            </InlineStack>
          ) : (<Text as="span" tone="subdued">—</Text>)}
        </IndexTable.Cell>
      </IndexTable.Row>
      <IndexTable.Row id={`${a.id}-d`} position={index + 0.5} disabled>
        <IndexTable.Cell colSpan={8}>
          <Collapsible id={`detail-${a.id}`} open={open} transition={{ duration: "150ms" }}>
            <Box padding="300" background="bg-surface-secondary">
              <BlockStack gap="150">
                <DetailLine label="Why this fired" value={leg.whyDetail ?? leg.why} />
                {showImpact && (
                  <DetailLine label="Booked margin"
                    value={`${a.dollar_impact_at_exec < 0 ? "-" : ""}${fmtMoney(Math.abs(a.dollar_impact_at_exec))} · ${leg.marginBasisLabel}`} />
                )}
                {leg.costLineage.length > 0 && (
                  <InlineStack gap="150" blockAlign="center">
                    <Text as="span" variant="bodySm" fontWeight="semibold">Cost lineage:</Text>
                    {leg.costLineage.map((s, i) => (
                      <Badge key={i} tone={s.source === "unavailable" ? "warning" : undefined}>
                        {`${s.kind === "ad_spend" ? "Ad spend" : s.kind === "cogs" ? "COGS" : "Price"}: ${COST_SOURCE_LABELS[s.source] ?? s.source}`}
                      </Badge>
                    ))}
                  </InlineStack>
                )}
              </BlockStack>
            </Box>
          </Collapsible>
        </IndexTable.Cell>
      </IndexTable.Row>
    </>
  );
}

function DetailLine({ label, value }: { label: string; value: string }) {
  return (
    <InlineStack gap="150">
      <Text as="span" variant="bodySm" fontWeight="semibold">{label}:</Text>
      <Text as="span" variant="bodySm" tone="subdued">{value}</Text>
    </InlineStack>
  );
}
```

Then in `Audit()`, replace the table Card with:

```tsx
        <Card padding="0">
          <IndexTable
            selectable={false}
            itemCount={audit.length}
            headings={[
              { title: "" }, { title: "Time" }, { title: "Action" }, { title: "Mode" },
              { title: "Target" }, { title: "Impact", alignment: "end" }, { title: "Status" }, { title: "" },
            ]}
          >
            {audit.map((a, i) => (
              <AuditRowEx key={a.id} a={a} index={i} submitting={submitting} />
            ))}
          </IndexTable>
        </Card>
```

> Remove the now-unused `recoveredOf`-adjacent `rows` block, the `DataTable`-era `Tooltip`/`Badge` row helpers, and the `DETECTOR_LABELS`/`DETECTOR_TERMS`/`actorLabel` imports if no longer referenced (the detector now reads through `leg.why`). Keep `StatTile`, the empty state, banners, and `DownloadPoButton` unchanged. Keep `recovered`/`successRate` for the StatTiles.

- [ ] **Step 3: Typecheck + lint**

Run: `npm run typecheck`
Expected: exit 0.
Run: `npx eslint app/routes/app.audit.tsx --max-warnings=0`
Expected: clean (remove any unused imports it flags).

- [ ] **Step 4: Build (Polaris IndexTable import sanity)**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add app/routes/app.audit.tsx
git commit -m "routes/app.audit: IndexTable with Auto/Manual badge, margin-source, why + cost-lineage detail"
```

---

## Task 12: Full pre-commit gate + final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole test suite**

Run: `npx vitest run`
Expected: all PASS (new + existing).

- [ ] **Step 2: Eval pipeline (CLAUDE.md pre-commit gate)**

Run in order, paste each result:
```bash
npm run typecheck   # exit 0
npm run lint        # exit 0
npm run build       # exit 0
```
Migrations changed → confirm the migration applied (Task 1) and `select … from v_audit_view limit 1` succeeds. No `.graphql`/schema.prisma change → skip codegen + prisma validate.

- [ ] **Step 3: `/code-review` on the working tree**

Run the `/code-review` slash command. Resolve every blocker; downgrade nits with a one-line justification.

- [ ] **Step 4: Patch sanity**

Run: `git diff main --stat` and `git diff main --check`
Expected: clean; no stray `console.log`, `.only`, `TODO(me)`, or commented-out blocks.

- [ ] **Step 5: Manual smoke (both surfaces)**

Use Playwright/Chrome MCP or the running app: open the extension audit log and the dashboard Action history. Verify on a real row each surface shows the Auto/Manual badge, the margin-source caption, and that expanding reveals Why / Booked margin / Cost lineage. Confirm a `merchant:web-dashboard` row reads "You (dashboard)".

---

## Self-review (completed by plan author)

**Spec coverage:** booked-margin provenance (Task 4 `marginBasisFor`), cost-data lineage (Task 7 resolution + Task 4 passthrough + UI Tasks 10/11), why-fired incl. autopilot persisted reason (Tasks 5/6) + derived fallback (Task 4), manual-vs-auto (Task 4 mode + UI badges, fixes the dead dashboard check in Task 10) — all mapped. Shared brain = Task 4; parity via Task 8 (dashboard) + Task 11 (extension). Fail-visibly = Task 7 catch. Tests = Tasks 3/4/6/8.

**Placeholder scan:** the only soft spot is Task 6 Step 1 (assert against the file's existing autopilot mock style) — flagged inline with both a spy and a `toHaveBeenCalledWith` form so the implementer can match whichever the file already uses.

**Type consistency:** `CostSource` (Task 2) used identically in Tasks 4/7/8/10/11; `auditLegibility`/`marginBasisFor`/`AD_SPEND_ACTIONS`/`MARGIN_ACTIONS` defined in Task 4 and consumed in Tasks 7/8/11; `trigger_reason`/`cost_sources` on `AuditEntry` (Task 2) read in Tasks 4/7; `AuditVM` fields (Task 8) consumed in Task 10. Consistent.
