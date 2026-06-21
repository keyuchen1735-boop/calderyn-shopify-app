# Calderyn Calibration (Foundation: Slices 0-1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the data model, RLS, peer-prior function, and the pure confidence math + nightly recompute that drives a read-only "Calibration %" header on both the embedded app and the dashboard. No action ever auto-executes in this plan.

**Architecture:** A single source-of-truth TypeScript math module (`app/lib/calibration/confidence.ts`) computes per-(detector, action) confidence and the shop's headline %. A nightly TS recompute (invoked by a thin cron) reads legal pairs + 90-day alert frequency + per-pair Beta counters, computes the smoothed headline, and writes it to `shops.calibration_pct`. Both UI surfaces read that one cached number. The math lives ONLY in TS (not duplicated in the Python engine) so a money-critical formula has exactly one implementation.

**Tech Stack:** Remix (Vite) + TypeScript (strict), Supabase Postgres (migrations as raw SQL in `supabase/migrations/`, applied via the supabase MCP `apply_migration`), Vitest for unit tests, pytest for the cross-tenant RLS guard, Polaris (embedded) + the dashboard's `cd-*` primitives + Lucide `CDIcon` (dashboard).

## Global Constraints

- **No autonomy in this plan.** Nothing here executes, proposes, or graduates any action. The header is display-only. Slices 2-6 (queue, learning, activity, graduation, tutorial) are out of scope and live in later plans.
- **The confidence formula has ONE implementation:** `app/lib/calibration/confidence.ts`, pure (no I/O, no `.server` imports). Never reimplement it in Python or in the dashboard.
- **Weights:** `detection 0.30 + historical 0.50 + reversibility 0.20` (sum 1.0). Prior strength `K = 8`. No-brainer prior bonus `1.30`, prior clamped `<= 0.95`. Copy these verbatim.
- **`GUARDRAIL_VETO = 0` forces `conf = 0`** with no override path.
- **Non-finite guard:** any `NaN`/`Infinity` confidence is treated as `0` and the value is never persisted raw.
- **DB money convention:** `guardrail_config.daily_action_budget` is stored in DOLLARS (the facade does `* 100` to cents). New calibration columns store integers (`calibration_pct` is 0-100).
- **action_kind is a Postgres enum** `public.action_kind` AND a TS union `ActionKind` (`app/lib/types.ts`). New columns reuse the existing enum; never redefine it.
- **RLS is mandatory and verified:** every new table gets `enable` + `force row level security` with a `shop_id = public.current_shop_id()` policy, verified by `get_advisors` (supabase MCP) showing 0 RLS ERRORs AND a cross-tenant test.
- **SECURITY DEFINER functions** use `set search_path = ''`, fully-qualified names, `revoke all ... from public`, and `grant execute ... to service_role` ONLY.
- **Pre-commit gate (from CLAUDE.md) before each commit:** `npm run typecheck` (exit 0), `npm run lint` (0 warnings on touched files), `npm run build` (exit 0), `npm run test` for touched tests. Migrations: verify with the supabase MCP, do not hand-edit applied migrations.
- **Worktree:** do all work in `feat/calibration-foundation` (create with the using-git-worktrees skill before Task 1).

---

## File Structure

**Slice 0 (data model):**
- Create `supabase/migrations/<ts>_pair_calibration.sql` - the per-pair trust table + `shops.calibration_pct`/`calibration_updated_at` columns + RLS.
- Create `supabase/migrations/<ts>_action_pair_prior_fn.sql` - the SECURITY DEFINER peer-prior function.
- Create `tests/engine/integration/test_rls_guard_calibration.py` - cross-tenant isolation test for the new table + function.

**Slice 1 (math + recompute + headers):**
- Create `app/lib/calibration/confidence.ts` - pure math (the heart).
- Create `app/lib/calibration/__tests__/confidence.test.ts` - unit tests.
- Create `app/lib/calibration/recompute.server.ts` - reads rows, computes, writes `calibration_pct`.
- Create `app/lib/calibration/__tests__/recompute.test.ts` - recompute tests with a stubbed Supabase client.
- Create `app/routes/cron.calibration-recompute.tsx` - thin cron that loops shops and calls recompute.
- Create `app/routes/__tests__/cron.calibration-recompute.test.ts` - auth + happy-path loader test.
- Modify `app/lib/types.ts` - add the `Calibration` contract type.
- Modify `app/lib/calderyn.server.ts` - add the `.calibration` namespace (`get()`).
- Create `app/components/calderyn/CalibrationHeader.tsx` - Polaris read-only header (embedded).
- Modify `app/routes/app._index.tsx` - add `calibration` to the loader payload + mount the header.
- Create `app/components/dashboard/CalibrationHeader.tsx` - dashboard `cd-*` read-only header.
- Modify `app/components/dashboard/context.ts` - add `calibration` to `DashboardCtx`.
- Modify `app/components/dashboard/DashboardApp.tsx` - fetch calibration on load.
- Modify `app/lib/dashboard/client.ts` - add `fetchCalibration()`.
- Create `app/routes/dashboard.api.calibration._index.tsx` - dashboard read API.
- Modify `app/components/dashboard/screens/Dashboard.tsx` - mount the dashboard header.

---

## Task 1: Migration - `pair_calibration` table + `shops` columns + RLS

**Files:**
- Create: `supabase/migrations/<ts>_pair_calibration.sql` (use a timestamp later than the newest existing migration, format `YYYYMMDDHHMMSS`)
- Reference pattern: `supabase/migrations/20260502000043_campaign_grade.sql` (table + read/write RLS), `tests/engine/schema/migrations/20260419000005_create_app_shop_id_helper.sql` (`current_shop_id()`)

**Interfaces:**
- Produces: table `public.pair_calibration` with PK `(shop_id, detector_id, action_kind)`; columns `alpha numeric`, `beta numeric`, `clean_approvals int`, `consecutive_clean_approvals int`, `consecutive_undos int`, `graduation_threshold int`, `merchant_disabled bool`, `graduated bool`, `last_conf int`, `last_detection numeric`, `updated_at timestamptz`. Columns `public.shops.calibration_pct int`, `public.shops.calibration_updated_at timestamptz`.

- [ ] **Step 1: Write the migration SQL**

Create `supabase/migrations/<ts>_pair_calibration.sql`:

```sql
-- Calderyn Calibration foundation: per-(detector, action) trust state + the
-- cached shop-level headline. No autonomy reads these yet; slice 1 only writes
-- shops.calibration_pct. RLS scopes every row to the owning shop.

create table public.pair_calibration (
  shop_id                       uuid    not null references public.shops(id) on delete cascade,
  detector_id                   text    not null,
  action_kind                   public.action_kind not null,
  alpha                         numeric not null default 0,
  beta                          numeric not null default 0,
  clean_approvals               integer not null default 0,
  consecutive_clean_approvals   integer not null default 0,
  consecutive_undos             integer not null default 0,
  graduation_threshold          integer not null default 75,
  merchant_disabled             boolean not null default false,
  graduated                     boolean not null default false,
  last_conf                     integer not null default 0,
  last_detection                numeric not null default 0,
  updated_at                    timestamptz not null default now(),
  primary key (shop_id, detector_id, action_kind)
);

create index pair_calibration_shop_idx on public.pair_calibration (shop_id);

alter table public.pair_calibration enable row level security;
alter table public.pair_calibration force row level security;

create policy pair_calibration_scope on public.pair_calibration
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());

alter table public.shops
  add column if not exists calibration_pct integer,
  add column if not exists calibration_updated_at timestamptz;
```

- [ ] **Step 2: Apply the migration via the supabase MCP**

Use the supabase MCP `apply_migration` tool with name `pair_calibration` and the SQL above. Expected: success, no error.

- [ ] **Step 3: Verify the table, RLS, and columns exist**

Use the supabase MCP `execute_sql`:

```sql
select tablename, rowsecurity
from pg_tables where schemaname='public' and tablename='pair_calibration';
select column_name from information_schema.columns
where table_schema='public' and table_name='shops'
  and column_name in ('calibration_pct','calibration_updated_at')
order by column_name;
```
Expected: `pair_calibration` with `rowsecurity=true`; both `shops` columns returned.

- [ ] **Step 4: Run the security advisor**

Use the supabase MCP `get_advisors` with type `security`. Expected: 0 ERROR-level advisories referencing `pair_calibration`. If any appear, fix the policy and re-apply before proceeding.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations
git commit -m "supabase/migrations: add pair_calibration table + shops.calibration_pct (calibration foundation)"
```

---

## Task 2: Migration - `action_pair_prior` SECURITY DEFINER function

**Files:**
- Create: `supabase/migrations/<ts>_action_pair_prior_fn.sql`
- Reference pattern: `supabase/migrations/20260619150000_autopilot_action_mu_fn.sql` (verbatim shape to mirror)

**Interfaces:**
- Produces: `public.action_pair_prior(p_shop_id uuid, p_detector_id text, p_action_kind text) returns numeric` - the anonymized peer p50 success rate for a pair, or NULL when no k-anon baseline exists. Service-role EXECUTE only.

- [ ] **Step 1: Write the function migration**

Create `supabase/migrations/<ts>_action_pair_prior_fn.sql`:

```sql
-- Anonymized peer prior for a (detector, action) pair. Mirrors
-- public.autopilot_action_mu: resolves the shop pseudonym, reads the moat
-- baseline, returns NULL when no k-anon (n>=5) baseline exists so the caller
-- falls back to the static seed. service_role EXECUTE only; keeps moat off
-- PostgREST.
create or replace function public.action_pair_prior(
  p_shop_id uuid,
  p_detector_id text,
  p_action_kind text
) returns numeric
language sql
stable
security definer
set search_path = ''
as $func$
  select b.p50
  from moat_keys.shop_pseudonym k
  join moat.action_baselines b
    on b.detector_id = p_detector_id
   and b.action_kind = p_action_kind
   and b.n >= 5
  where k.shop_id = p_shop_id
  limit 1;
$func$;

revoke all on function public.action_pair_prior(uuid, text, text) from public;
grant execute on function public.action_pair_prior(uuid, text, text) to service_role;
```

> Note: if `moat.action_baselines` does not exist yet (peer baselines not trained), the function migration still applies but the join yields NULL at runtime. Confirm the table name with `execute_sql: select to_regclass('moat.action_baselines');`. If it is NULL (table absent), keep the function as written (it returns NULL via the empty join) and record an open item that peer priors are inert until the engine ships baselines. Do not invent a table.

- [ ] **Step 2: Confirm the moat baseline table name before applying**

Use the supabase MCP `execute_sql`:
```sql
select to_regclass('moat.action_baselines') as baselines,
       to_regclass('moat_keys.shop_pseudonym') as pseudonym;
```
Expected: if both non-null, proceed as written. If `baselines` is null, adjust the function body to `select null::numeric` with a comment, OR locate the correct table via `select table_schema, table_name from information_schema.tables where table_schema in ('moat','moat_keys');` and use the real name. Apply only after the names are confirmed real.

- [ ] **Step 3: Apply via the supabase MCP**

Use `apply_migration` with name `action_pair_prior_fn`. Expected: success.

- [ ] **Step 4: Verify privileges (anon/authenticated cannot execute)**

Use `execute_sql`:
```sql
select grantee, privilege_type
from information_schema.routine_privileges
where routine_schema='public' and routine_name='action_pair_prior'
order by grantee;
```
Expected: `service_role` has EXECUTE; `public`, `anon`, `authenticated` do NOT appear (or have no EXECUTE).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations
git commit -m "supabase/migrations: add action_pair_prior() peer-prior fn (service_role only)"
```

---

## Task 3: Cross-tenant RLS guard test

**Files:**
- Create: `tests/engine/integration/test_rls_guard_calibration.py`
- Reference pattern: `tests/engine/integration/test_rls_guard.py`, `tests/engine/schema/migrations/20260419000005_create_app_shop_id_helper.sql` (`set_current_shop_id`)

**Interfaces:**
- Consumes: `public.set_current_shop_id(uuid)`, `public.current_shop_id()`, the `pair_calibration` table from Task 1, the `action_pair_prior` fn from Task 2.

- [ ] **Step 1: Write the failing test**

Create `tests/engine/integration/test_rls_guard_calibration.py`, mirroring the role-switch + GUC pattern in the sibling `test_rls_guard.py`. Adapt connection/fixture imports to match that file:

```python
"""Cross-tenant isolation for the calibration tables/functions.

Asserts (1) shop A bound via set_current_shop_id sees only its own
pair_calibration rows, (2) an authenticated session with NO shop bound sees
zero rows, (3) anon/authenticated cannot execute action_pair_prior.
Mirrors test_rls_guard.py.
"""
import uuid
import pytest
from tests.engine.integration.conftest import authenticated_conn, service_conn  # match sibling imports


def _seed_pair(conn, shop_id):
    conn.execute(
        """insert into public.pair_calibration
           (shop_id, detector_id, action_kind, alpha, beta)
           values (%s, 'sku_stockout_vs_spend', 'pause_campaign', 1, 0)
           on conflict do nothing""",
        (shop_id,),
    )


def test_pair_calibration_is_shop_scoped(service_conn, authenticated_conn):
    shop_a, shop_b = uuid.uuid4(), uuid.uuid4()
    # service role seeds both shops (bypasses RLS)
    for s in (shop_a, shop_b):
        service_conn.execute("insert into public.shops (id, shop) values (%s, %s) on conflict do nothing",
                             (s, f"{s}.myshopify.com"))
        _seed_pair(service_conn, s)
    service_conn.commit()

    # authenticated, bound to shop A: sees only A
    authenticated_conn.execute("select public.set_current_shop_id(%s)", (shop_a,))
    rows = authenticated_conn.execute(
        "select shop_id from public.pair_calibration").fetchall()
    assert rows, "shop A should see its own row"
    assert all(r[0] == shop_a for r in rows), "shop A must not see shop B"


def test_unbound_session_sees_nothing(service_conn, authenticated_conn):
    shop_a = uuid.uuid4()
    service_conn.execute("insert into public.shops (id, shop) values (%s, %s) on conflict do nothing",
                         (shop_a, f"{shop_a}.myshopify.com"))
    _seed_pair(service_conn, shop_a)
    service_conn.commit()
    # no set_current_shop_id -> current_shop_id() is NULL -> deny all
    authenticated_conn.execute("reset all")
    rows = authenticated_conn.execute("select * from public.pair_calibration").fetchall()
    assert rows == []


def test_action_pair_prior_not_callable_by_authenticated(authenticated_conn):
    with pytest.raises(Exception):
        authenticated_conn.execute(
            "select public.action_pair_prior(%s,'sku_stockout_vs_spend','pause_campaign')",
            (uuid.uuid4(),),
        )
```

> Before running, open `tests/engine/integration/test_rls_guard.py` and match its exact fixture names/imports (the stubs above assume `service_conn`/`authenticated_conn` fixtures and a `.execute(...).fetchall()` cursor helper; rename to whatever that file uses).

- [ ] **Step 2: Run to verify it passes against the applied migrations**

Run: `pytest tests/engine/integration/test_rls_guard_calibration.py -v`
Expected: all 3 tests PASS (the tables/fn already exist from Tasks 1-2). If `test_action_pair_prior_not_callable_by_authenticated` fails because the call returns NULL instead of raising, change the assertion to `assert authenticated_conn.execute(...).fetchone()[0] is None` only if the grant truly denies execute via a different mechanism; otherwise the raise is correct.

- [ ] **Step 3: Commit**

```bash
git add tests/engine/integration/test_rls_guard_calibration.py
git commit -m "tests/engine: cross-tenant RLS guard for pair_calibration + action_pair_prior"
```

---

## Task 4: Pure confidence math module (the heart)

**Files:**
- Create: `app/lib/calibration/confidence.ts`
- Test: `app/lib/calibration/__tests__/confidence.test.ts`
- Reference: `app/lib/types.ts` (`ActionKind`), `app/lib/labels.ts` (`DetectorId`, `DETECTOR_TO_ACTIONS`)

**Interfaces:**
- Produces:
  - `type Tier = "reversible" | "hard_to_reverse" | "irreversible"`
  - `const NO_BRAINER: ReadonlySet<string>` (keys `"<detector>:<action>"`)
  - `const HAS_EXECUTOR: ReadonlySet<ActionKind>`
  - `function actionTier(action: ActionKind): Tier`
  - `function pairPrior(tier: Tier, isNoBrainer: boolean, peerP50: number | null): number`
  - `function historical(alpha: number, beta: number, pPrior: number, k?: number): number`
  - `function confidence(i: { guardrailVeto: 0 | 1; detection: number; historical: number; reversibility: number }): number`
  - `function reversibilityFactor(tier: Tier): number`
  - `function calibrationPct(pairs: { conf: number; weight: number }[]): number`
  - `function smooth(raw: number, prevDisplay: number | null, opts?: { maxStep?: number; deadBand?: number }): number`

- [ ] **Step 1: Write the failing tests**

Create `app/lib/calibration/__tests__/confidence.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  pairPrior, historical, confidence, calibrationPct, smooth,
  actionTier, reversibilityFactor, NO_BRAINER, HAS_EXECUTOR,
} from "../confidence";
import { DETECTOR_TO_ACTIONS } from "../../labels";

describe("pairPrior", () => {
  it("applies the no-brainer bonus and clamps at 0.95", () => {
    expect(pairPrior("reversible", true, null)).toBeCloseTo(0.715, 3); // 0.55*1.30
    expect(pairPrior("reversible", false, null)).toBeCloseTo(0.55, 3);
    expect(pairPrior("irreversible", true, null)).toBeCloseTo(0.26, 3); // 0.20*1.30
    expect(pairPrior("reversible", true, 0.99)).toBe(0.95); // peer wins but clamped
  });
  it("prefers a positive peer p50 over the static seed", () => {
    expect(pairPrior("irreversible", false, 0.8)).toBeCloseTo(0.8, 3);
    expect(pairPrior("irreversible", false, 0)).toBeCloseTo(0.20, 3); // 0 ignored -> seed
  });
});

describe("historical", () => {
  it("returns the prior when there is no real evidence (no divide-by-zero)", () => {
    expect(historical(0, 0, 0.715, 8)).toBeCloseTo(0.715, 3);
  });
  it("moves toward 1 with approvals", () => {
    expect(historical(10, 0, 0.5, 8)).toBeGreaterThan(0.8);
  });
  it("moves toward 0 with rejections", () => {
    expect(historical(0, 10, 0.5, 8)).toBeLessThan(0.25);
  });
});

describe("confidence", () => {
  it("the canonical cold-start no-brainer lands ~74", () => {
    const c = confidence({
      guardrailVeto: 1, detection: 0.6, historical: 0.715, reversibility: 1.0,
    });
    expect(c).toBe(74);
  });
  it("a zero guardrail veto forces 0 regardless of other factors", () => {
    expect(confidence({ guardrailVeto: 0, detection: 1, historical: 1, reversibility: 1 })).toBe(0);
  });
  it("never returns NaN", () => {
    expect(confidence({ guardrailVeto: 1, detection: NaN, historical: 0.5, reversibility: 1 })).toBe(0);
  });
});

describe("calibrationPct", () => {
  it("is a weight-normalized average", () => {
    // 2 pairs: conf 80 weight 3, conf 0 weight 1 -> (240+0)/4 = 60
    expect(calibrationPct([{ conf: 80, weight: 3 }, { conf: 0, weight: 1 }])).toBe(60);
  });
  it("returns 0 when there is no weight", () => {
    expect(calibrationPct([])).toBe(0);
    expect(calibrationPct([{ conf: 50, weight: 0 }])).toBe(0);
  });
});

describe("smooth", () => {
  it("returns raw on first run (no prior display)", () => {
    expect(smooth(40, null)).toBe(40);
  });
  it("clamps the daily move to +/-5", () => {
    expect(smooth(100, 50)).toBe(55); // EWMA would be 85, clamped to +5
    expect(smooth(0, 50)).toBe(45);   // clamped to -5
  });
  it("holds steady inside the dead-band", () => {
    expect(smooth(51, 50)).toBe(50); // EWMA ~50.3, |delta|<1 -> hold
  });
});

describe("structural sets are internally consistent", () => {
  it("every NO_BRAINER key is a legal (detector, action) pair", () => {
    for (const key of NO_BRAINER) {
      const [det, act] = key.split(":");
      const actions = (DETECTOR_TO_ACTIONS as Record<string, string[]>)[det];
      expect(actions, `detector ${det} must exist`).toBeTruthy();
      expect(actions).toContain(act);
    }
  });
  it("every executor kind has a tier", () => {
    for (const k of HAS_EXECUTOR) expect(["reversible","hard_to_reverse","irreversible"]).toContain(actionTier(k));
  });
  it("reversibilityFactor is ordered", () => {
    expect(reversibilityFactor("reversible")).toBeGreaterThan(reversibilityFactor("hard_to_reverse"));
    expect(reversibilityFactor("hard_to_reverse")).toBeGreaterThan(reversibilityFactor("irreversible"));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/lib/calibration/__tests__/confidence.test.ts`
Expected: FAIL with "Cannot find module '../confidence'".

- [ ] **Step 3: Write the implementation**

Create `app/lib/calibration/confidence.ts`:

```ts
// Pure confidence math for Calderyn Calibration. NO I/O, NO .server imports:
// this is the single source of truth for the formula, imported by the recompute
// job and (later slices) the synchronous approve/reject path and the dashboard.
// See docs/superpowers/specs/2026-06-20-calderyn-calibration-design.md sections 2-3.

import type { ActionKind } from "../types";

export type Tier = "reversible" | "hard_to_reverse" | "irreversible";

const WEIGHTS = { detection: 0.3, historical: 0.5, reversibility: 0.2 } as const;
const K_PRIOR = 8;
const NOBRAINER_BONUS = 1.3;
const PRIOR_CLAMP_MAX = 0.95;

// Static seed prior per reversibility tier when no peer baseline exists.
const REVERSIBILITY_BASE: Record<Tier, number> = {
  reversible: 0.55,
  hard_to_reverse: 0.35,
  irreversible: 0.2,
};

// The reversibility FACTOR (0..1) that feeds the blended score.
const REVERSIBILITY_FACTOR: Record<Tier, number> = {
  reversible: 1.0,
  hard_to_reverse: 0.5,
  irreversible: 0.2,
};

// Kinds with a real platform executor today. Kinds NOT here get GUARDRAIL_VETO=0
// (conf 0) in the recompute. Keep in sync with ExecutableKind in execute.server.ts.
export const HAS_EXECUTOR: ReadonlySet<ActionKind> = new Set<ActionKind>([
  "pause_campaign",
  "resume_campaign",
  "reduce_campaign_budget",
  "increase_campaign_budget",
  "reallocate_budget",
  "reallocate_inventory",
]);

// Per-action reversibility tier. increase_campaign_budget is hard_to_reverse
// until it gains an undoAction branch (spec I7); physical/free-ship kinds are
// irreversible.
const ACTION_TIER: Partial<Record<ActionKind, Tier>> = {
  pause_campaign: "reversible",
  resume_campaign: "reversible",
  reduce_campaign_budget: "reversible",
  reallocate_budget: "reversible",
  exclude_geo: "reversible",
  snooze_alert: "reversible",
  increase_campaign_budget: "hard_to_reverse",
  create_po_draft: "hard_to_reverse",
  reallocate_inventory: "irreversible",
  exclude_sku_free_ship: "irreversible",
  raise_free_ship_threshold: "irreversible",
};

// Pairs that ship pre-trusted (still shadow-gated before any autonomy in later
// slices). Keys are "<detector>:<action>". A test asserts each is a legal pair.
export const NO_BRAINER: ReadonlySet<string> = new Set<string>([
  "sku_stockout_vs_spend:pause_campaign",
  "campaign_below_breakeven:pause_campaign",
]);

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);
const clampInt = (n: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, Math.round(n)));

export function actionTier(action: ActionKind): Tier {
  return ACTION_TIER[action] ?? "irreversible";
}

export function reversibilityFactor(tier: Tier): number {
  return REVERSIBILITY_FACTOR[tier];
}

export function pairPrior(tier: Tier, isNoBrainer: boolean, peerP50: number | null): number {
  if (peerP50 != null && peerP50 > 0) return Math.min(PRIOR_CLAMP_MAX, clamp01(peerP50));
  const base = REVERSIBILITY_BASE[tier];
  const p = isNoBrainer ? base * NOBRAINER_BONUS : base;
  return Math.min(PRIOR_CLAMP_MAX, clamp01(p));
}

export function historical(alpha: number, beta: number, pPrior: number, k = K_PRIOR): number {
  const a0 = k * pPrior;
  const b0 = k * (1 - pPrior);
  const denom = alpha + beta + a0 + b0;
  if (!(denom > 0)) return clamp01(pPrior);
  return clamp01((alpha + a0) / denom);
}

export function confidence(i: {
  guardrailVeto: 0 | 1;
  detection: number;
  historical: number;
  reversibility: number;
}): number {
  if (i.guardrailVeto === 0) return 0;
  const blended =
    WEIGHTS.detection * clamp01(i.detection) +
    WEIGHTS.historical * clamp01(i.historical) +
    WEIGHTS.reversibility * clamp01(i.reversibility);
  const c = Math.round(100 * blended);
  return Number.isFinite(c) ? clampInt(c, 0, 100) : 0;
}

export function calibrationPct(pairs: { conf: number; weight: number }[]): number {
  let totalWeight = 0;
  let acc = 0;
  for (const p of pairs) {
    const w = Number.isFinite(p.weight) && p.weight > 0 ? p.weight : 0;
    const c = Number.isFinite(p.conf) ? p.conf : 0;
    totalWeight += w;
    acc += w * c;
  }
  if (!(totalWeight > 0)) return 0;
  return clampInt(acc / totalWeight, 0, 100);
}

export function smooth(
  raw: number,
  prevDisplay: number | null,
  opts?: { maxStep?: number; deadBand?: number },
): number {
  const maxStep = opts?.maxStep ?? 5;
  const deadBand = opts?.deadBand ?? 1;
  if (prevDisplay == null) return clampInt(raw, 0, 100);
  const ewma = 0.3 * raw + 0.7 * prevDisplay;
  let next = Math.round(ewma);
  const delta = next - prevDisplay;
  if (Math.abs(delta) < deadBand) return prevDisplay;
  if (delta > maxStep) next = prevDisplay + maxStep;
  else if (delta < -maxStep) next = prevDisplay - maxStep;
  return clampInt(next, 0, 100);
}
```

- [ ] **Step 4: Run to verify all tests pass**

Run: `npx vitest run app/lib/calibration/__tests__/confidence.test.ts`
Expected: PASS (all describe blocks green). The canonical no-brainer test confirms `conf === 74`.

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add app/lib/calibration/confidence.ts app/lib/calibration/__tests__/confidence.test.ts
git commit -m "lib/calibration: pure confidence math (single source of truth) + unit tests"
```

---

## Task 5: Recompute module - compute and persist the headline

**Files:**
- Create: `app/lib/calibration/recompute.server.ts`
- Test: `app/lib/calibration/__tests__/recompute.test.ts`
- Reference: `app/lib/calderyn.server.ts` (`getSupabase`), `app/lib/labels.ts` (`DETECTOR_TO_ACTIONS`), Task 4 module.

**Interfaces:**
- Consumes: the `confidence.ts` exports; a Supabase client; `DETECTOR_TO_ACTIONS`.
- Produces:
  - `interface RecomputeDeps { sb: SupabaseClient }`
  - `async function recomputeShopCalibration(shopId: string, deps: RecomputeDeps): Promise<{ shopId: string; pairs: number; raw: number; display: number }>`
  - `function computeWeights(detectorFires: Record<string, number>): { detector: string; action: ActionKind; weight: number }[]` (exported pure helper, unit-tested)

- [ ] **Step 1: Write the failing test**

Create `app/lib/calibration/__tests__/recompute.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { computeWeights, recomputeShopCalibration } from "../recompute.server";

describe("computeWeights", () => {
  it("splits each detector's weight across its legal actions with rank-decay", () => {
    const w = computeWeights({ campaign_below_breakeven: 10 });
    // campaign_below_breakeven -> [pause_campaign, reduce_campaign_budget, snooze_alert]
    const pause = w.find((x) => x.action === "pause_campaign");
    const snooze = w.find((x) => x.action === "snooze_alert");
    expect(pause!.weight).toBeGreaterThan(snooze!.weight); // first action ranked higher
    const total = w.reduce((s, x) => s + x.weight, 0);
    expect(total).toBeGreaterThan(0);
  });
  it("gives a new shop (no fires) a non-empty seed distribution", () => {
    const w = computeWeights({});
    expect(w.length).toBeGreaterThan(0);
    expect(w.reduce((s, x) => s + x.weight, 0)).toBeGreaterThan(0);
  });
});

describe("recomputeShopCalibration", () => {
  it("writes a smoothed calibration_pct and returns the summary", async () => {
    const updates: Record<string, unknown>[] = [];
    const sb = makeStubSb({
      pairRows: [], // cold start, no per-pair evidence
      detectorFires: { sku_stockout_vs_spend: 5, campaign_below_breakeven: 3 },
      prevPct: null,
      onShopUpdate: (patch) => updates.push(patch),
    });
    const res = await recomputeShopCalibration("shop-1", { sb });
    expect(res.shopId).toBe("shop-1");
    expect(res.display).toBeGreaterThanOrEqual(0);
    expect(res.display).toBeLessThanOrEqual(100);
    expect(updates[0]).toHaveProperty("calibration_pct", res.display);
    expect(updates[0]).toHaveProperty("calibration_updated_at");
  });
});

// Minimal Supabase stub: supports the exact call chain recompute uses.
function makeStubSb(opts: {
  pairRows: Record<string, unknown>[];
  detectorFires: Record<string, number>;
  prevPct: number | null;
  onShopUpdate: (patch: Record<string, unknown>) => void;
}) {
  return {
    from(table: string) {
      if (table === "pair_calibration") {
        return { select: () => ({ eq: () => Promise.resolve({ data: opts.pairRows, error: null }) }) };
      }
      if (table === "alerts") {
        // recompute reads recent alerts to count detector fires
        const rows = Object.entries(opts.detectorFires).flatMap(([d, n]) =>
          Array.from({ length: n }, () => ({ detector_id: d })),
        );
        return { select: () => ({ eq: () => ({ gte: () => Promise.resolve({ data: rows, error: null }) }) }) };
      }
      if (table === "shops") {
        return {
          select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { calibration_pct: opts.prevPct }, error: null }) }) }),
          update: (patch: Record<string, unknown>) => {
            opts.onShopUpdate(patch);
            return { eq: () => Promise.resolve({ error: null }) };
          },
        };
      }
      // action_pair_prior is called via rpc, stubbed below
      return { select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) };
    },
    rpc: () => Promise.resolve({ data: null, error: null }), // peer prior absent -> static seed
  } as unknown as import("@supabase/supabase-js").SupabaseClient;
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/lib/calibration/__tests__/recompute.test.ts`
Expected: FAIL with "Cannot find module '../recompute.server'".

- [ ] **Step 3: Write the implementation**

Create `app/lib/calibration/recompute.server.ts`:

```ts
// Nightly recompute of the shop calibration headline. Reads legal pairs +
// 90-day alert frequency + per-pair Beta counters, computes conf via the pure
// confidence module, weight-averages, smooths against the prior display, and
// writes shops.calibration_pct. No autonomy. See spec sections 2 + 9 (I6).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActionKind } from "../types";
import { DETECTOR_TO_ACTIONS, type DetectorId } from "../labels";
import {
  actionTier, calibrationPct, confidence, historical, pairPrior,
  reversibilityFactor, smooth, HAS_EXECUTOR, NO_BRAINER,
} from "./confidence";

export interface RecomputeDeps {
  sb: SupabaseClient;
}

const RANK_DECAY = 0.6; // first action gets 60% of a detector's weight; rest split the remainder
const SEED_FIRES = 1; // every legal detector gets a baseline fire so new shops show a stable %
const WINDOW_DAYS = 90;
const DETECTION_COLD = 0.6; // detection factor at cold start (spec section 2)

export function computeWeights(
  detectorFires: Record<string, number>,
): { detector: string; action: ActionKind; weight: number }[] {
  const out: { detector: string; action: ActionKind; weight: number }[] = [];
  const detectors = Object.keys(DETECTOR_TO_ACTIONS) as DetectorId[];
  let totalDetectorWeight = 0;
  const detWeight: Record<string, number> = {};
  for (const d of detectors) {
    const w = (detectorFires[d] ?? 0) + SEED_FIRES;
    detWeight[d] = w;
    totalDetectorWeight += w;
  }
  for (const d of detectors) {
    const actions = DETECTOR_TO_ACTIONS[d];
    const dShare = detWeight[d] / totalDetectorWeight;
    actions.forEach((action, i) => {
      // rank-decay: first action RANK_DECAY of the share, remainder split evenly
      const share =
        actions.length === 1
          ? 1
          : i === 0
            ? RANK_DECAY
            : (1 - RANK_DECAY) / (actions.length - 1);
      out.push({ detector: d, action, weight: dShare * share });
    });
  }
  return out;
}

export async function recomputeShopCalibration(
  shopId: string,
  deps: RecomputeDeps,
): Promise<{ shopId: string; pairs: number; raw: number; display: number }> {
  const { sb } = deps;

  // 1. per-pair Beta counters (may be empty at cold start)
  const { data: pairData, error: pairErr } = await sb
    .from("pair_calibration")
    .select("detector_id, action_kind, alpha, beta")
    .eq("shop_id", shopId);
  if (pairErr) throw pairErr;
  const pairMap = new Map<string, { alpha: number; beta: number }>();
  for (const r of pairData ?? []) {
    pairMap.set(`${r.detector_id}:${r.action_kind}`, {
      alpha: Number(r.alpha ?? 0),
      beta: Number(r.beta ?? 0),
    });
  }

  // 2. 90-day detector fire counts
  const sinceIso = new Date(Date.now() - WINDOW_DAYS * 86400_000).toISOString();
  const { data: alertRows, error: alertErr } = await sb
    .from("alerts")
    .select("detector_id")
    .eq("shop_id", shopId)
    .gte("created_at", sinceIso);
  if (alertErr) throw alertErr;
  const fires: Record<string, number> = {};
  for (const r of alertRows ?? []) fires[r.detector_id] = (fires[r.detector_id] ?? 0) + 1;

  // 3. conf per weighted pair
  const weights = computeWeights(fires);
  const scored: { conf: number; weight: number }[] = [];
  for (const { detector, action, weight } of weights) {
    const key = `${detector}:${action}`;
    const tier = actionTier(action);
    const veto: 0 | 1 = HAS_EXECUTOR.has(action) ? 1 : 0;
    let peerP50: number | null = null;
    try {
      const { data } = await sb.rpc("action_pair_prior", {
        p_shop_id: shopId,
        p_detector_id: detector,
        p_action_kind: action,
      });
      peerP50 = data == null ? null : Number(data);
    } catch {
      peerP50 = null; // peer baselines optional; fall back to static seed
    }
    const isNb = NO_BRAINER.has(key);
    const prior = pairPrior(tier, isNb, peerP50);
    const ev = pairMap.get(key);
    const hist = historical(ev?.alpha ?? 0, ev?.beta ?? 0, prior);
    const conf = confidence({
      guardrailVeto: veto,
      detection: DETECTION_COLD,
      historical: hist,
      reversibility: reversibilityFactor(tier),
    });
    scored.push({ conf, weight });
  }

  const raw = calibrationPct(scored);

  // 4. smooth vs prior display, write back
  const { data: shopRow, error: shopErr } = await sb
    .from("shops")
    .select("calibration_pct")
    .eq("id", shopId)
    .maybeSingle();
  if (shopErr) throw shopErr;
  const prev = shopRow?.calibration_pct == null ? null : Number(shopRow.calibration_pct);
  const display = smooth(raw, prev);

  const { error: updErr } = await sb
    .from("shops")
    .update({ calibration_pct: display, calibration_updated_at: new Date().toISOString() })
    .eq("id", shopId);
  if (updErr) throw updErr;

  return { shopId, pairs: scored.length, raw, display };
}
```

> Note on `new Date()`: this runs in the Node server (recompute job), not a workflow script, so `Date.now()`/`new Date()` are fine here.

- [ ] **Step 4: Run to verify tests pass**

Run: `npx vitest run app/lib/calibration/__tests__/recompute.test.ts`
Expected: PASS. If the stub call-chain shape does not match (e.g. `.select().eq()` arity), adjust the stub in the test to mirror the real chain, not the implementation.

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add app/lib/calibration/recompute.server.ts app/lib/calibration/__tests__/recompute.test.ts
git commit -m "lib/calibration: nightly recompute of the shop calibration headline"
```

---

## Task 6: Thin recompute cron route

**Files:**
- Create: `app/routes/cron.calibration-recompute.tsx`
- Test: `app/routes/__tests__/cron.calibration-recompute.test.ts`
- Reference: `app/routes/cron.autopilot-train.tsx` (auth + structure), `app/lib/calderyn.server.ts` (`getSupabase`).

**Interfaces:**
- Consumes: `recomputeShopCalibration` (Task 5), the CRON_SECRET auth helper used by sibling crons (find it in `cron.autopilot-train.tsx`, e.g. `isAuthorizedCron`).
- Produces: a Remix `loader` returning `json({ ok, shops, errors, duration_ms })`.

- [ ] **Step 1: Write the failing test**

Create `app/routes/__tests__/cron.calibration-recompute.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the recompute + supabase so the route is tested in isolation.
vi.mock("../../lib/calibration/recompute.server", () => ({
  recomputeShopCalibration: vi.fn(async (id: string) => ({ shopId: id, pairs: 1, raw: 25, display: 25 })),
}));
vi.mock("../../lib/calderyn.server", () => ({
  getSupabase: () => ({
    from: () => ({ select: () => Promise.resolve({ data: [{ id: "shop-1" }], error: null }) }),
  }),
}));

import { loader } from "../cron.calibration-recompute";

const req = (auth?: string) =>
  new Request("https://app.test/cron/calibration-recompute", {
    headers: auth ? { authorization: auth } : {},
  });

beforeEach(() => {
  process.env.CRON_SECRET = "s3cret";
});

describe("cron.calibration-recompute loader", () => {
  it("401s without the bearer secret", async () => {
    const res = await loader({ request: req(), params: {}, context: {} } as never);
    expect(res.status).toBe(401);
  });
  it("recomputes each shop with the correct secret", async () => {
    const res = await loader({ request: req("Bearer s3cret"), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.shops).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/routes/__tests__/cron.calibration-recompute.test.ts`
Expected: FAIL with "Cannot find module '../cron.calibration-recompute'".

- [ ] **Step 3: Write the implementation**

Open `app/routes/cron.autopilot-train.tsx` and copy its exact auth helper import (the example below assumes `isAuthorizedCron`; match the real name). Create `app/routes/cron.calibration-recompute.tsx`:

```tsx
// Nightly: recompute every shop's calibration headline. Thin by design - the
// math lives in lib/calibration. Deviation from the autopilot-train pattern
// (which POSTs to a Python engine fn) is intentional: the confidence formula
// must have ONE implementation (TS), so we do not round-trip to Python.

import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { getSupabase } from "../lib/calderyn.server";
import { recomputeShopCalibration } from "../lib/calibration/recompute.server";
import { isAuthorizedCron } from "./cron.autopilot-train"; // reuse the sibling's exported helper; if it is not exported, copy the 3-line check verbatim

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const sb = getSupabase();
  const startedAt = Date.now();
  const errors: string[] = [];
  let count = 0;

  const { data: shops, error } = await sb.from("shops").select("id");
  if (error) return json({ ok: false, error: error.message }, { status: 502 });

  for (const s of shops ?? []) {
    try {
      await recomputeShopCalibration(s.id as string, { sb });
      count += 1;
    } catch (err) {
      errors.push(`${s.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const duration_ms = Date.now() - startedAt;
  if (errors.length > 0) {
    console.error(`[cron.calibration-recompute] partial: ${errors.join("; ")}`);
    return json({ ok: false, shops: count, errors, duration_ms }, { status: 500 });
  }
  return json({ ok: true, shops: count, errors, duration_ms });
};
```

> If `isAuthorizedCron` is not exported from `cron.autopilot-train.tsx`, either export it there (one-line change, separate commit) or inline the same check. Do not weaken the auth.

- [ ] **Step 4: Run to verify tests pass**

Run: `npx vitest run app/routes/__tests__/cron.calibration-recompute.test.ts`
Expected: PASS (401 and 200 cases).

- [ ] **Step 5: Register the cron schedule**

Open `vercel.json` and add the cron entry next to the existing ones (match their cadence format). Example entry (adjust path/time to the repo's convention):

```json
{ "path": "/cron/calibration-recompute", "schedule": "30 6 * * *" }
```
Verify the existing crons' path style (with or without leading `/cron/`); match exactly. If crons live elsewhere (e.g. a `crons` array), append there.

- [ ] **Step 6: Build + commit**

```bash
npm run typecheck && npm run build
git add app/routes/cron.calibration-recompute.tsx app/routes/__tests__/cron.calibration-recompute.test.ts vercel.json
git commit -m "routes/cron.calibration-recompute: nightly TS recompute of calibration headline"
```

---

## Task 7: `Calibration` contract type + `.calibration` facade namespace

**Files:**
- Modify: `app/lib/types.ts` (add interface near `GuardrailConfig`, ~line 238)
- Modify: `app/lib/calderyn.server.ts` (add namespace in the `calderynClient` return, after the `guardrails` namespace ~line 1258)
- Test: `app/lib/__tests__/calderyn-calibration.test.ts`

**Interfaces:**
- Produces:
  - `interface Calibration { pct: number | null; updated_at: string | null }` in `app/lib/types.ts`
  - `client.calibration.get(signal?): Promise<Calibration>` on `CalderynClient`

- [ ] **Step 1: Add the type**

In `app/lib/types.ts`, after the `GuardrailConfig` interface, add:

```ts
/** Read-only calibration headline for a shop. Foundation slice: just the
 * cached %; later slices add per-pair detail and trend. */
export interface Calibration {
  pct: number | null;
  updated_at: string | null;
}
```

- [ ] **Step 2: Write the failing facade test**

Create `app/lib/__tests__/calderyn-calibration.test.ts`. Mirror the mocking style of existing `app/lib/.../__tests__` tests (they mock `@supabase/supabase-js`). Minimal shape:

```ts
import { describe, it, expect, vi } from "vitest";

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (t: string) => {
      if (t === "shops") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({
                data: { calibration_pct: 25, calibration_updated_at: "2026-06-20T00:00:00Z" },
                error: null,
              }),
            }),
          }),
        };
      }
      return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) };
    },
  }),
}));

import { calderynClient } from "../calderyn.server";

describe("client.calibration.get", () => {
  it("returns the cached pct and timestamp", async () => {
    const c = calderynClient("demo.myshopify.com");
    const cal = await c.calibration.get();
    expect(cal.pct).toBe(25);
    expect(cal.updated_at).toBe("2026-06-20T00:00:00Z");
  });
});
```

> Match the actual `calderynClient` shop-resolution path. If it resolves `shop_id` via a query first, extend the mock's `shops` branch to also answer that lookup (check how `guardrails.get` resolves `shopIdP` in the file and mirror it).

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run app/lib/__tests__/calderyn-calibration.test.ts`
Expected: FAIL ("calibration is undefined" or property access error).

- [ ] **Step 4: Add the namespace**

In `app/lib/calderyn.server.ts`, inside the object returned by `calderynClient`, after the `guardrails` namespace, add:

```ts
    calibration: {
      async get(_signal?: AbortSignal): Promise<Calibration> {
        try {
          const shopId = await shopIdP;
          const { data, error } = await supabase
            .from("shops")
            .select("calibration_pct, calibration_updated_at")
            .eq("id", shopId)
            .maybeSingle();
          if (error) throw error;
          return {
            pct: data?.calibration_pct == null ? null : Number(data.calibration_pct),
            updated_at: (data?.calibration_updated_at as string | null) ?? null,
          };
        } catch (err) {
          rethrow("calibration.get", err);
        }
      },
    },
```

Add `Calibration` to the existing `import type { ... } from "./types"` line at the top of the file.

- [ ] **Step 5: Run to verify tests pass + typecheck**

Run: `npx vitest run app/lib/__tests__/calderyn-calibration.test.ts && npm run typecheck`
Expected: PASS, exit 0.

- [ ] **Step 6: Commit**

```bash
git add app/lib/types.ts app/lib/calderyn.server.ts app/lib/__tests__/calderyn-calibration.test.ts
git commit -m "lib/calderyn: add calibration.get() facade + Calibration type"
```

---

## Task 8: Embedded calibration header (Polaris, read-only)

**Files:**
- Create: `app/components/calderyn/CalibrationHeader.tsx`
- Modify: `app/routes/app._index.tsx` (loader payload + mount)
- Test: `app/components/calderyn/__tests__/CalibrationHeader.test.tsx`

**Interfaces:**
- Consumes: `Calibration` type, the loader's new `calibration` field.
- Produces: `<CalibrationHeader calibration={...} />` default-exported component.

- [ ] **Step 1: Write the failing component test**

Create `app/components/calderyn/__tests__/CalibrationHeader.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AppProvider } from "@shopify/polaris";
import en from "@shopify/polaris/locales/en.json";
import CalibrationHeader from "../CalibrationHeader";

function wrap(ui: React.ReactNode) {
  return render(<AppProvider i18n={en}>{ui}</AppProvider>);
}

describe("CalibrationHeader", () => {
  it("shows the percentage when calibrated", () => {
    wrap(<CalibrationHeader calibration={{ pct: 42, updated_at: "2026-06-20T00:00:00Z" }} />);
    expect(screen.getByText(/42%/)).toBeTruthy();
  });
  it("shows a warming-up state when pct is null", () => {
    wrap(<CalibrationHeader calibration={{ pct: null, updated_at: null }} />);
    expect(screen.getByText(/calibrating/i)).toBeTruthy();
  });
});
```

> If the repo has no React Testing Library set up, check an existing `*.test.tsx` for the render helper used and match it. If there is none, downgrade this to a pure-function test of a small `calibrationLabel(pct)` helper exported from the component file, and verify the visual render manually with the run skill instead.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/components/calderyn/__tests__/CalibrationHeader.test.tsx`
Expected: FAIL ("Cannot find module '../CalibrationHeader'").

- [ ] **Step 3: Write the component**

Create `app/components/calderyn/CalibrationHeader.tsx`:

```tsx
// Read-only calibration headline for the embedded dashboard. Display only -
// no actions, no autonomy. The number comes from shops.calibration_pct via
// the nightly recompute.
import { Card, BlockStack, InlineStack, Text, ProgressBar, Badge } from "@shopify/polaris";
import type { Calibration } from "../../lib/types";

export function calibrationLabel(pct: number | null): string {
  if (pct == null) return "Calibrating your agent";
  if (pct >= 90) return "Nearly autonomous";
  if (pct >= 50) return "Learning fast";
  return "Getting started";
}

export default function CalibrationHeader({ calibration }: { calibration: Calibration }) {
  const pct = calibration.pct;
  return (
    <Card>
      <BlockStack gap="200">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingMd">Calderyn Calibration</Text>
          <Badge tone={pct != null && pct >= 50 ? "success" : "attention"}>
            {pct == null ? "Warming up" : `${pct}%`}
          </Badge>
        </InlineStack>
        <ProgressBar progress={pct ?? 0} size="small" tone="primary" />
        <Text as="p" tone="subdued" variant="bodySm">
          {calibrationLabel(pct)}. As you approve or reject what Calderyn suggests, it learns
          your shop and this number climbs toward 100% (fully hands-off).
        </Text>
      </BlockStack>
    </Card>
  );
}
```

> Verify these Polaris component names exist in the installed version (`@shopify/polaris@^12.27`) by checking another route that imports `Card`/`ProgressBar`/`Badge`. Adjust prop names (e.g. `ProgressBar` `tone`) if the version differs.

- [ ] **Step 4: Run to verify tests pass**

Run: `npx vitest run app/components/calderyn/__tests__/CalibrationHeader.test.tsx`
Expected: PASS.

- [ ] **Step 5: Wire into the loader**

In `app/routes/app._index.tsx`:
1. Add `calibration: Calibration;` to the `LoaderPayload` type (import `Calibration` from `../lib/types`).
2. Add `client.calibration.get(request.signal)` to the `Promise.all([...])` and destructure it.
3. Include `calibration` in BOTH `json<LoaderPayload>({...})` returns (success AND the catch fallback - in the catch use `calibration: { pct: null, updated_at: null }`).

Success-path edit (extend the existing array + return):

```ts
    const [alerts, audit, campaigns, guardrails, benchmarks, calibration] = await Promise.all([
      client.alerts.list({ status: "open" }, request.signal),
      client.audit.list(request.signal),
      client.campaigns.list(request.signal),
      client.guardrails.get(request.signal),
      getPeerBenchmarks(session.shop),
      client.calibration.get(request.signal),
    ]);
```
Add `calibration,` to the success `json(...)` object and `calibration: { pct: null, updated_at: null },` to the catch `json(...)` object.

- [ ] **Step 6: Mount the header**

In the component, destructure `calibration` from `useLoaderData`, import the header (`import CalibrationHeader from "../components/calderyn/CalibrationHeader";`), and render it as the FIRST `Layout.Section` (full width) above the existing alert-queue section:

```tsx
        <Layout.Section>
          <CalibrationHeader calibration={calibration} />
        </Layout.Section>
```

- [ ] **Step 7: Gate + commit**

```bash
npm run typecheck && npm run lint && npm run build
git add app/components/calderyn/CalibrationHeader.tsx app/components/calderyn/__tests__/CalibrationHeader.test.tsx app/routes/app._index.tsx
git commit -m "routes/app._index: mount read-only Calderyn Calibration header (embedded)"
```

---

## Task 9: Dashboard calibration header (parity)

**Files:**
- Create: `app/routes/dashboard.api.calibration._index.tsx`
- Create: `app/components/dashboard/CalibrationHeader.tsx`
- Modify: `app/lib/dashboard/client.ts` (add `fetchCalibration()`)
- Modify: `app/components/dashboard/context.ts` (add `calibration` to `DashboardCtx`)
- Modify: `app/components/dashboard/DashboardApp.tsx` (fetch + set on load)
- Modify: `app/components/dashboard/screens/Dashboard.tsx` (mount header)
- Reference: `app/routes/dashboard.api.audit._index.tsx` (one-liner API pattern), the `ActivityFeed` + `Card` usage in `screens/Dashboard.tsx`.

**Interfaces:**
- Consumes: `client.calibration.get()` (Task 7).
- Produces: `dashboard.api.calibration._index` loader returning `{ pct, updated_at }`; `app.calibration` on `DashboardCtx`; `<CalibrationHeader app={app} />`.

- [ ] **Step 1: Write the read API route**

Open `app/routes/dashboard.api.audit._index.tsx` to copy its auth/shop-resolution boilerplate. Create `app/routes/dashboard.api.calibration._index.tsx`:

```tsx
import { json, type LoaderFunctionArgs } from "@remix-run/node";
// Reuse the EXACT auth + shop resolution the sibling dashboard.api.* routes use.
import { requireDashboardShop } from "../lib/dashboard/auth.server"; // match the real helper name in dashboard.api.audit._index.tsx
import { calderynClient } from "../lib/calderyn.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const shop = await requireDashboardShop(request); // copy the sibling's pattern exactly
  const client = calderynClient(shop);
  const cal = await client.calibration.get(request.signal);
  return json({ pct: cal.pct, updated_at: cal.updated_at });
};
```

> Do not invent `requireDashboardShop`. Open `dashboard.api.audit._index.tsx` and replicate whatever it does to authenticate and obtain `shop` (cookie/session). The only new line is the `calderynClient(shop).calibration.get(...)` call.

- [ ] **Step 2: Add the client fetch**

In `app/lib/dashboard/client.ts`, add (mirroring `fetchGuardrails`):

```ts
  async fetchCalibration(): Promise<{ pct: number | null; updated_at: string | null }> {
    const res = await fetch("/dashboard/api/calibration", { credentials: "include" });
    if (!res.ok) return { pct: null, updated_at: null };
    return res.json();
  },
```
Match the file's existing fetch style (base path, error handling) exactly.

- [ ] **Step 3: Extend the context type**

In `app/components/dashboard/context.ts`, add to `DashboardCtx`:

```ts
  calibration: { pct: number | null; updated_at: string | null } | null;
```

- [ ] **Step 4: Fetch on load**

In `app/components/dashboard/DashboardApp.tsx`, add `client.fetchCalibration()` to the `Promise.all` in `load`, a `const [..., cal] = ...` destructure, a `setCalibration(cal)` state setter (add `const [calibration, setCalibration] = useState<DashboardCtx["calibration"]>(null);`), and include `calibration` in the `DashboardCtx` value object passed down.

- [ ] **Step 5: Write the dashboard header component**

Create `app/components/dashboard/CalibrationHeader.tsx` using the dashboard's own primitives (`Card`, `CDIcon`, `cd-*` classes - copy class usage from `ActivityFeed` in `screens/Dashboard.tsx`):

```tsx
import { Card } from "./primitives"; // match the real import path used by screens/Dashboard.tsx
import { CDIcon } from "./icons";
import type { DashboardCtx } from "./context";

function label(pct: number | null): string {
  if (pct == null) return "Calibrating";
  if (pct >= 90) return "Nearly autonomous";
  if (pct >= 50) return "Learning fast";
  return "Getting started";
}

export function CalibrationHeader({ app }: { app: DashboardCtx }) {
  const pct = app.calibration?.pct ?? null;
  return (
    <Card>
      <div className="cd-pad flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="cd-feed-icon"><CDIcon name="target" size={16} strokeWidth={1.9} /></span>
          <div>
            <h2 className="cd-h2">Calderyn Calibration</h2>
            <div className="cd-caption">{label(pct)} — climbs toward 100% as you train it</div>
          </div>
        </div>
        <div className="cd-stat-num">{pct == null ? "—" : `${pct}%`}</div>
      </div>
      <div className="cd-pad-x cd-pad-b">
        <div className="cd-meter"><span style={{ width: `${pct ?? 0}%` }} /></div>
      </div>
    </Card>
  );
}
```

> Three things to verify against the real dashboard code, do not guess: (1) the import path for `Card` (the grounding shows it is used in `screens/Dashboard.tsx` - copy that import); (2) that `target` exists in `CD_ICONS` (`app/components/dashboard/icons.tsx`) - if not, add it per the CLAUDE.md icon rule (one line importing `Target` from `lucide-react`); (3) the meter/progress class - reuse whatever the dashboard already uses for bars (search for an existing `cd-meter`/`RingGauge`/`Meter`; if none, a simple `<div>` with inline width is fine). Replace the em dash in the caption with a hyphen if copying literally.

- [ ] **Step 6: Mount it**

In `app/components/dashboard/screens/Dashboard.tsx`, import `CalibrationHeader` and render `<CalibrationHeader app={app} />` as the first child of the screen's top container (above the existing stat row / focus card).

- [ ] **Step 7: Gate + commit**

```bash
npm run typecheck && npm run lint && npm run build
git add app/routes/dashboard.api.calibration._index.tsx app/components/dashboard/CalibrationHeader.tsx app/lib/dashboard/client.ts app/components/dashboard/context.ts app/components/dashboard/DashboardApp.tsx app/components/dashboard/screens/Dashboard.tsx
git commit -m "dashboard: mount read-only Calderyn Calibration header (parity)"
```

---

## Task 10: End-to-end verification on a real shop

**Files:** none (verification only)

- [ ] **Step 1: Trigger a recompute for the review store**

With the dev server running (or against prod per the testing-on-prod convention), invoke the cron with the secret:

```bash
curl -s -X GET "$SHOPIFY_APP_URL/cron/calibration-recompute" -H "authorization: Bearer $CRON_SECRET" | cat
```
Expected: `{"ok":true,"shops":N,...}`.

- [ ] **Step 2: Confirm the value landed**

Use the supabase MCP `execute_sql`:
```sql
select shop, calibration_pct, calibration_updated_at
from public.shops where calibration_pct is not null order by calibration_updated_at desc limit 5;
```
Expected: rows with an integer `calibration_pct`. RECORD the actual baseline value for a fresh shop here: ______. (See "Open item: baseline magnitude" below - if it is far from the 20-25% target, that is a tuning conversation, not a bug.)

- [ ] **Step 3: Eyeball both surfaces**

Use the run/verify skill to open the embedded app home and the dashboard. Confirm the Calibration header renders with the same number on both. Confirm no console errors.

- [ ] **Step 4: Final gate**

```bash
npm run typecheck && npm run lint && npm run build && npm run test
```
Expected: all exit 0.

---

## Open item: baseline magnitude (flagged from spec self-review)

The spec's Section 2 worked example labels the baseline "~24%", but its own contribution column sums to ~36 (18.5 + 5 + 7.4 + 5). The true baseline is emergent: it depends on how many veto-0 (no-executor) pairs dilute the average under the real `DETECTOR_TO_ACTIONS` set and the seed weighting in `computeWeights`. This plan does NOT hardcode 25. Task 10 Step 2 measures the real number. If it lands outside the 20-25% target the founder wants, the fix is to tune the seed weighting (`SEED_FIRES`, `RANK_DECAY`, or a per-detector seed table) so the veto-0 tail pulls it into range, OR to adjust the stated baseline. Either way it stays an honest function of the math, never a hardcoded display value. This is a decision to confirm with the founder once measured.

## Self-Review

**Spec coverage (slices 0-1 only):**
- Section 8 data model: `pair_calibration` + `shops.calibration_pct` + `action_pair_prior` -> Tasks 1, 2. (Deferred to later plans by design: `action_feedback`, `calibration_rule` - they have no consumer until slices 2-3.)
- Section 9 I9 (RLS isolation, advisors, service_role-only fn) -> Tasks 1, 2, 3.
- Section 2 math (weights, K, prior, no-brainer bonus, smoothing, NaN/zero guards) -> Task 4.
- Section 2 headline recompute + cron -> Tasks 5, 6.
- Section 10 dashboard parity (header) -> Tasks 7, 9; embedded header -> Task 8.

**Deliberate deviations from the spec (documented):** (1) recompute runs in TS, not a Python engine route, to keep the money-critical formula single-implementation; (2) slice 0 trimmed to only the tables slice 1 consumes; (3) the baseline % is measured, not assumed (open item above).

**Placeholder scan:** No "TBD/TODO". Every code step has real code. The "match the sibling helper name" notes are verification instructions, not placeholders - each names the exact file to copy from.

**Type consistency:** `Calibration { pct, updated_at }` defined in Task 7 is used identically in Tasks 8-9. `recomputeShopCalibration(shopId, { sb })` signature in Task 5 matches its call in Task 6. `confidence(...)` / `historical(...)` / `pairPrior(...)` signatures in Task 4 match their use in Task 5.
