# Outcome-Gated Autonomy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a (detector, action) pair graduate to autonomous only when the merchant has approved it AND its past executions are measured net-positive in real dollars; auto-demote on measured losses or undo; expand the graduatable action set from 3 to 7; and bound high-stakes price/inventory moves by guardrail size instead of a time delay.

**Architecture:** Trust is decided by the pure `graduationVerdict` in `app/lib/calibration/graduation.ts`, consumed by the nightly recompute (`recompute.server.ts`) and the live gate (`graduation.server.ts`) that autopilot calls before every autonomous action (`autopilot.server.ts:197,614`). This plan threads a new *measured-outcome* counter into that verdict. The outcome signal originates in the Python engine (`compute_action_reward`), is persisted per action onto `action_audit`, and is tallied per pair onto `pair_calibration` by the calibration recompute job. Phase 1 wires the whole loop for the two kinds the kernel already scores; Phase 2 builds new kernel branches for four more kinds and adds their guardrail caps.

**Tech Stack:** TypeScript (Remix, `@supabase/supabase-js`), Python 3.11 (asyncpg, Decimal), Postgres (Supabase migrations + the engine test-schema mirror under `tests/engine/schema/migrations`), Vitest (TS), pytest (Python).

## Global Constraints

- **TypeScript strict; no `any`** without written justification — prefer `unknown` + narrowing. `npm run typecheck` is authoritative.
- **Server-only files end `.server.ts`** and must never be imported by a client module. Pure logic (no I/O, no `.server` import) lives in plain modules so both surfaces can import it (e.g. `confidence.ts`, `graduation.ts`, `bands.ts`).
- **Every Supabase migration is mirrored** into the engine test schema: a `supabase/migrations/<ts>_*.sql` that the engine reads also needs a matching `tests/engine/schema/migrations/<ts>_*.sql`. Never hand-edit applied migrations; add new ones. Run `npx prisma validate` is N/A here (no Prisma schema for these tables); validate by applying locally.
- **RLS:** every new table/column on a shop-scoped table inherits the existing `shop_id = public.current_shop_id()` policy; SECURITY DEFINER RPCs are `service_role`-only with `set search_path = ''` and explicit `revoke ... from anon, authenticated` (mirror `calibration_record_approval`).
- **Money is integer cents** in storage; convert to `Decimal`/dollars only at the SQL→Python or display boundary.
- **Reward sign convention (fixed):** positive `Decimal` = the action helped; `0` = no opinion; undo = `UNDO_PENALTY = Decimal("-100")` hard negative override. New Phase 2 branches obey this.
- **Dashboard parity (MANDATORY):** merchant-visible changes (two-bar progress, new graduatable actions) ship on BOTH the embedded app (`app/routes/app.*`, Polaris) and the dashboard (`app/routes/dashboard.*`, non-Polaris). Mirror the data contract, never copy Polaris JSX.
- **Browser-visible source hygiene:** no AI/provenance/tool markers in any browser-facing string, comment, or identifier.
- **Pre-commit gate** before any major commit: `/code-review`, `git diff --check`, then `npm run typecheck` → `npm run lint` → `npm run build` (all exit 0), plus `pytest` for engine changes. Never bypass.

---

## File Map

**Phase 1**

- Modify `supabase/migrations/` → new `20260626120000_pair_calibration_outcomes.sql` (+ engine mirror): add `pair_calibration.net_positive_outcomes`, `pair_calibration.last_outcome_sign`; add `action_audit.reward_signal`, `action_audit.reward_window_closed_at`.
- Modify `engine/calderyn_engine/moat/action_reward_inputs.py`: per-kind confirmation window; return `window_closed` flag.
- Create `engine/calderyn_engine/moat/action_reward_windows.py`: pure per-kind window table.
- Create `engine/calderyn_engine/moat/persist_action_rewards.py`: write closed-window reward signs back to `action_audit`.
- Modify `engine/_autopilot_train_core.py`: call the new persist step.
- Modify `app/lib/calibration/graduation.ts`: add `MIN_OUTCOMES`, outcome gate + demotion to `graduationVerdict`.
- Modify `app/lib/calibration/graduation.server.ts` and `recompute.server.ts`: read + pass the outcome tally; recompute the per-pair tally + demotion.
- Create `app/lib/calibration/outcomes.ts`: pure tally/demotion helpers.
- Create `app/lib/calibration/outcomes.server.ts`: read closed-window `action_audit` rewards → per-pair net.
- Modify `app/lib/actions/undo.server.ts`: increment `consecutive_undos` on undo (finish undo→demote).
- Create `supabase/migrations/20260626120100_calibration_record_undo_fn.sql` (+ mirror): `calibration_record_undo` RPC.
- Modify `app/components/dashboard/screens/LiveEngine.tsx` (+ `app/routes/app.engine.tsx` view-model) and the dashboard mirror: surface the two-bar progress.

**Phase 2**

- Modify `engine/calderyn_engine/moat/action_rewards.py`: signed branches for `resume_campaign`, `discontinue_sku`, `adjust_price`, `reallocate_inventory`.
- Modify `engine/calderyn_engine/moat/action_reward_inputs.py`: derive inputs for SKU/price/inventory actions (non-campaign metrics).
- Modify `app/lib/calibration/confidence.ts`: add `adjust_price` to `ACTION_TIER` (hard_to_reverse).
- Modify `app/lib/calibration/graduation.ts`: expand `GRADUATABLE`.
- Centralize `HAS_UNDO_BRANCH` into `app/lib/calibration/undo-branches.ts` (remove the two drifting copies).
- Modify `supabase/migrations/` → `20260626130000_autopilot_price_inventory_caps.sql` (+ mirror): `maxPriceChangePct`, `maxInventoryUnitsPerMove` guardrail fields.
- Modify `app/lib/actions/guardrails.ts`: cap checks for `adjust_price`, `reallocate_inventory`.
- Modify `app/lib/actions/guardrails.server.ts` + `autopilot.server.ts`: supply facts + enforce on the autonomous path.
- Modify dashboard + embedded settings UI: expose the two new cap fields; show the four new actions in the calibration track.

---

# PHASE 1 — Outcome-gated trust for pause + reduce_campaign_budget

Delivers the full loop (two-bar graduation, outcome demotion, finished undo→demote, per-kind window, persisted scores) for the two kinds `compute_action_reward` already grades. Shippable on its own.

### Task 1: Migration — outcome columns on `pair_calibration` and `action_audit`

**Files:**
- Create: `supabase/migrations/20260626120000_pair_calibration_outcomes.sql`
- Create: `tests/engine/schema/migrations/20260626120000_pair_calibration_outcomes.sql` (identical body; the engine test harness applies this dir)

**Interfaces:**
- Produces: `pair_calibration.net_positive_outcomes integer`, `pair_calibration.last_outcome_sign smallint`; `action_audit.reward_signal numeric(12,2)`, `action_audit.reward_window_closed_at timestamptz`. Consumed by Tasks 4, 7, 8, 9.

- [ ] **Step 1: Write the migration**

```sql
-- Outcome-gated autonomy: persist per-action reward outcomes and a per-pair tally.
-- net_positive_outcomes = (positive measured outcomes) - (negative), floored at 0,
-- recomputed nightly from closed-window action_audit rewards. last_outcome_sign is
-- the sign of the most recently closed outcome (-1/0/1), used for demotion.
alter table public.pair_calibration
  add column if not exists net_positive_outcomes integer not null default 0,
  add column if not exists last_outcome_sign smallint not null default 0;

-- Per-action reward: written by the nightly engine pass ONCE the action's per-kind
-- confirmation window has elapsed. reward_signal is the signed Decimal from
-- compute_action_reward; reward_window_closed_at marks when it became countable.
alter table public.action_audit
  add column if not exists reward_signal numeric(12,2),
  add column if not exists reward_window_closed_at timestamptz;

-- Index the closed-window lookups the calibration recompute does per shop.
create index if not exists action_audit_reward_closed_idx
  on public.action_audit (shop_id, action_kind, reward_window_closed_at)
  where reward_window_closed_at is not null;
```

- [ ] **Step 2: Apply locally and verify columns exist**

Run: `psql "$DATABASE_URL" -f supabase/migrations/20260626120000_pair_calibration_outcomes.sql` then
`psql "$DATABASE_URL" -c "\d public.pair_calibration" | grep net_positive_outcomes`
Expected: a row showing `net_positive_outcomes | integer`.

- [ ] **Step 3: Copy the identical body to the engine mirror**

Create `tests/engine/schema/migrations/20260626120000_pair_calibration_outcomes.sql` with the same SQL.

- [ ] **Step 4: Run the engine schema bootstrap to confirm it applies clean**

Run: `pytest tests/engine/integration/test_rls_guard_calibration.py -q`
Expected: PASS (the harness rebuilds the schema from `tests/engine/schema/migrations`; a broken migration fails collection).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260626120000_pair_calibration_outcomes.sql tests/engine/schema/migrations/20260626120000_pair_calibration_outcomes.sql
git commit -m "calibration: add outcome columns to pair_calibration + action_audit"
```

---

### Task 2: Engine — pure per-kind confirmation window

**Files:**
- Create: `engine/calderyn_engine/moat/action_reward_windows.py`
- Test: `tests/engine/moat/test_action_reward_windows.py`

**Interfaces:**
- Produces: `confirmation_window_days(action_kind: str) -> int`. Consumed by Task 3.

- [ ] **Step 1: Write the failing test**

```python
from calderyn_engine.moat.action_reward_windows import confirmation_window_days


def test_defensive_actions_confirm_in_three_days():
    assert confirmation_window_days("pause_campaign") == 3
    assert confirmation_window_days("reduce_campaign_budget") == 3


def test_growth_and_physical_actions_confirm_in_seven_days():
    for k in ("resume_campaign", "reallocate_budget", "discontinue_sku",
              "adjust_price", "reallocate_inventory"):
        assert confirmation_window_days(k) == 7


def test_unknown_kind_falls_back_to_fourteen():
    assert confirmation_window_days("create_po_draft") == 14
    assert confirmation_window_days("") == 14
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/engine/moat/test_action_reward_windows.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'calderyn_engine.moat.action_reward_windows'`.

- [ ] **Step 3: Write minimal implementation**

```python
"""Pure per-action-kind outcome confirmation windows (design 2026-06-26 §4.2).

How many days after an autopilot action we wait before its measured outcome can
be counted toward graduation. Matched to how fast each action's dollar signal
actually appears: defensive loss-stops show within days; growth/demand and
physical moves need about a week of orders. No I/O.
"""
from __future__ import annotations

# Defensive: the bleed stops the instant spend stops; 3 days confirms it held.
_FAST_DAYS = 3
# Growth / demand-dependent / physical: a week of conversions to read the result.
_SLOW_DAYS = 7
# Unknown / not-yet-scored kinds: the old conservative window.
_DEFAULT_DAYS = 14

_WINDOWS: dict[str, int] = {
    "pause_campaign": _FAST_DAYS,
    "reduce_campaign_budget": _FAST_DAYS,
    "resume_campaign": _SLOW_DAYS,
    "reallocate_budget": _SLOW_DAYS,
    "discontinue_sku": _SLOW_DAYS,
    "adjust_price": _SLOW_DAYS,
    "reallocate_inventory": _SLOW_DAYS,
}


def confirmation_window_days(action_kind: str) -> int:
    """Days to wait before ``action_kind``'s outcome is countable."""
    return _WINDOWS.get(action_kind, _DEFAULT_DAYS)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/engine/moat/test_action_reward_windows.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add engine/calderyn_engine/moat/action_reward_windows.py tests/engine/moat/test_action_reward_windows.py
git commit -m "engine/moat: per-kind outcome confirmation window table"
```

---

### Task 3: Engine — thread the per-kind window through reward-input derivation

**Files:**
- Modify: `engine/calderyn_engine/moat/action_reward_inputs.py`
- Test: `tests/engine/moat/test_action_reward_inputs_window.py`

**Interfaces:**
- Consumes: `confirmation_window_days` (Task 2).
- Produces: `ActionRewardInput` gains `window_closed: bool` and `action_created_at: datetime`. The POST window is now `[action_date, action_date + confirmation_window_days(kind)]` instead of a flat 14 days. Consumed by Task 4.

- [ ] **Step 1: Write the failing test**

```python
from datetime import date, datetime, timezone
from decimal import Decimal

from calderyn_engine.moat.action_reward_inputs import derive_action_reward_inputs


class _FakeConn:
    """Minimal asyncpg-like stub: returns canned rows per SQL prefix."""
    def __init__(self, actions, spend, grades):
        self._actions, self._spend, self._grades = actions, spend, grades

    async def fetch(self, sql, *args):
        s = sql.strip()
        if s.startswith("SELECT a.id"):
            return self._actions
        if s.startswith("SELECT campaign_id"):
            return self._spend
        return self._grades


async def test_pause_window_closed_after_three_days(monkeypatch):
    # Action 4 days ago, pause_campaign (3-day window) -> window_closed True.
    created = datetime(2026, 6, 22, tzinfo=timezone.utc)
    conn = _FakeConn(
        actions=[{
            "id": "a1", "action_kind": "pause_campaign", "campaign_id": "c1",
            "created_at": created, "detector_id": "campaign_below_breakeven",
            "old_budget_cents": 1000, "new_budget_cents": 0, "undone": False,
        }],
        spend=[
            {"campaign_id": "c1", "phase": "pre", "spend_cents": 5000, "revenue_cents": 1000},
            {"campaign_id": "c1", "phase": "post", "spend_cents": 0, "revenue_cents": 0},
        ],
        grades=[{"campaign_id": "c1", "break_even_roas": Decimal("2")}],
    )
    rows = await derive_action_reward_inputs(conn, "shop1", date(2026, 6, 26))
    assert rows[0]["window_closed"] is True
    assert rows[0]["reward"] > 0  # loss averted on a below-break-even campaign


async def test_pause_window_open_before_three_days():
    created = datetime(2026, 6, 25, tzinfo=timezone.utc)  # 1 day ago vs run 2026-06-26
    conn = _FakeConn(
        actions=[{
            "id": "a2", "action_kind": "pause_campaign", "campaign_id": "c1",
            "created_at": created, "detector_id": "campaign_below_breakeven",
            "old_budget_cents": 1000, "new_budget_cents": 0, "undone": False,
        }],
        spend=[], grades=[],
    )
    rows = await derive_action_reward_inputs(conn, "shop1", date(2026, 6, 26))
    assert rows[0]["window_closed"] is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/engine/moat/test_action_reward_inputs_window.py -v`
Expected: FAIL with `KeyError: 'window_closed'`.

- [ ] **Step 3: Edit the implementation**

In `action_reward_inputs.py`, add the import and extend the TypedDict:

```python
from calderyn_engine.moat.action_reward_windows import confirmation_window_days
```

```python
class ActionRewardInput(TypedDict):
    shop_id: str
    detector_id: str
    action_kind: str
    campaign_id: str
    chosen_pct: float
    reward: Decimal
    action_id: str
    window_closed: bool
    action_created_at: datetime
```

Replace the per-action window block (the `lo`/`hi`/`spend_rows` section) so the
POST window is per-kind and a `window_closed` flag is computed against `run_date`:

```python
        action_date = created.date()
        win_days = confirmation_window_days(a["action_kind"])
        lo = action_date - timedelta(days=WINDOW_DAYS)   # PRE stays a 14d baseline
        hi = action_date + timedelta(days=win_days)       # POST is per-kind
        window_closed = run_date >= hi

        spend_rows = await conn.fetch(_SPEND_SQL, shop_id, action_date, lo, hi)
```

And add the two new keys to the appended dict:

```python
        out.append(
            ActionRewardInput(
                shop_id=shop_id,
                detector_id=a["detector_id"],
                action_kind=a["action_kind"],
                campaign_id=cid,
                chosen_pct=float(chosen_pct),
                reward=reward,
                action_id=a["id"],
                window_closed=window_closed,
                action_created_at=created,
            )
        )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/engine/moat/test_action_reward_inputs_window.py tests/engine/moat -q`
Expected: PASS, and no regression in existing `action_reward_inputs`/`action_peer_etl` tests (they ignore the extra keys).

- [ ] **Step 5: Commit**

```bash
git add engine/calderyn_engine/moat/action_reward_inputs.py tests/engine/moat/test_action_reward_inputs_window.py
git commit -m "engine/moat: per-kind POST window + window_closed flag on reward inputs"
```

---

### Task 4: Engine — persist closed-window reward signs to `action_audit`

**Files:**
- Create: `engine/calderyn_engine/moat/persist_action_rewards.py`
- Modify: `engine/_autopilot_train_core.py`
- Test: `tests/engine/moat/test_persist_action_rewards.py`

**Interfaces:**
- Consumes: `derive_action_reward_inputs` (Task 3, now with `window_closed`).
- Produces: `persist_action_rewards(conn, shop_id, run_date) -> int` (count written). Writes `action_audit.reward_signal` + `reward_window_closed_at` for every closed-window, not-yet-persisted action. Consumed by the TS tally (Task 7).

- [ ] **Step 1: Write the failing test**

```python
from datetime import date, datetime, timezone
from decimal import Decimal

from calderyn_engine.moat.persist_action_rewards import persist_action_rewards


class _RecordingConn:
    def __init__(self, rows):
        self._rows = rows
        self.writes = []  # (action_id, reward_signal, closed_at)

    async def fetch(self, sql, *args):
        s = sql.strip()
        if s.startswith("SELECT a.id"):
            return self._rows
        if s.startswith("SELECT campaign_id"):
            return []
        return []

    async def execute(self, sql, *args):
        self.writes.append(args)


async def test_persists_only_closed_window_rewards(monkeypatch):
    # One closed (4d old pause), one open (today). Only the closed one is written.
    closed = {
        "id": "a1", "action_kind": "pause_campaign", "campaign_id": "c1",
        "created_at": datetime(2026, 6, 22, tzinfo=timezone.utc),
        "detector_id": "campaign_below_breakeven",
        "old_budget_cents": 1000, "new_budget_cents": 0, "undone": False,
    }
    open_row = dict(closed, id="a2", created_at=datetime(2026, 6, 26, tzinfo=timezone.utc))
    conn = _RecordingConn([closed, open_row])
    n = await persist_action_rewards(conn, "shop1", date(2026, 6, 26))
    assert n == 1
    assert conn.writes[0][0] == "a1"  # action_id of the closed row
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/engine/moat/test_persist_action_rewards.py -v`
Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 3: Write the implementation**

```python
"""Persist per-action reward signs back to action_audit once their per-kind
confirmation window has closed (design 2026-06-26 §4). This is the seam the
TypeScript calibration recompute reads — the engine computes the dollar outcome,
records reward_signal + reward_window_closed_at, and the trust layer tallies it.

Idempotent: only rows whose window has closed AND that have not yet been written
(reward_window_closed_at is null) are updated. Own raw data only (invariant A5).
"""
from __future__ import annotations
from datetime import date

from calderyn_engine.moat.action_reward_inputs import derive_action_reward_inputs

_UPDATE_SQL = """
UPDATE public.action_audit
   SET reward_signal = $2,
       reward_window_closed_at = now()
 WHERE id = $1
   AND shop_id = $3
   AND reward_window_closed_at IS NULL
"""


async def persist_action_rewards(conn, shop_id: str, run_date: date) -> int:
    """Write reward_signal for every closed-window, unpersisted autopilot action.

    Returns the number of action_audit rows updated.
    """
    written = 0
    for r in await derive_action_reward_inputs(conn, shop_id, run_date):
        if not r["window_closed"]:
            continue
        await conn.execute(_UPDATE_SQL, r["action_id"], r["reward"], shop_id)
        written += 1
    return written
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/engine/moat/test_persist_action_rewards.py -v`
Expected: PASS.

- [ ] **Step 5: Wire it into the train core**

In `engine/_autopilot_train_core.py::handle`, after the existing ETL + train calls,
add a persist pass over the cohort and surface its count. Find the block that
returns the summary dict and add, before it:

```python
    rewards_persisted = 0
    for shop_id in cohort_shop_ids:          # the same shop list train_action_policies iterates
        try:
            rewards_persisted += await persist_action_rewards(conn, shop_id, run_date)
        except Exception as exc:             # fail-visible per shop; do not abort the run
            errors.append(f"persist_rewards {shop_id}: {exc}")
```

Add the import at the top:

```python
from calderyn_engine.moat.persist_action_rewards import persist_action_rewards
```

And add `"rewards_persisted": rewards_persisted,` to the returned summary dict.
(If `cohort_shop_ids` is not already in scope, reuse the same `_cohort_shop_ids`
helper `train_action_policies` uses — see `action_trainer.py` import.)

- [ ] **Step 6: Run the engine test suite**

Run: `pytest tests/engine/moat -q`
Expected: PASS (no regressions; new persist test green).

- [ ] **Step 7: Commit**

```bash
git add engine/calderyn_engine/moat/persist_action_rewards.py engine/_autopilot_train_core.py tests/engine/moat/test_persist_action_rewards.py
git commit -m "engine/moat: persist closed-window reward signs to action_audit"
```

---

### Task 5: TS pure — outcome tally helper

**Files:**
- Create: `app/lib/calibration/outcomes.ts`
- Test: `app/lib/calibration/__tests__/outcomes.test.ts`

**Interfaces:**
- Produces:
  - `interface OutcomeRow { signal: number; closedAt: string }`
  - `interface OutcomeTally { netPositive: number; lastSign: -1 | 0 | 1 }`
  - `tallyOutcomes(rows: OutcomeRow[]): OutcomeTally` — `netPositive = max(0, #positive − #negative)`; `lastSign` = sign of the row with the latest `closedAt`.
  Consumed by Tasks 7, 8.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { tallyOutcomes } from "../outcomes";

describe("tallyOutcomes", () => {
  it("nets positives minus negatives, floored at zero", () => {
    const t = tallyOutcomes([
      { signal: 12, closedAt: "2026-06-20T00:00:00Z" },
      { signal: 8, closedAt: "2026-06-21T00:00:00Z" },
      { signal: -100, closedAt: "2026-06-22T00:00:00Z" },
    ]);
    expect(t.netPositive).toBe(1); // 2 positive - 1 negative
  });

  it("floors net at zero when negatives dominate", () => {
    const t = tallyOutcomes([
      { signal: -5, closedAt: "2026-06-20T00:00:00Z" },
      { signal: -5, closedAt: "2026-06-21T00:00:00Z" },
      { signal: 3, closedAt: "2026-06-19T00:00:00Z" },
    ]);
    expect(t.netPositive).toBe(0);
  });

  it("reports the sign of the most recently closed outcome", () => {
    const t = tallyOutcomes([
      { signal: 50, closedAt: "2026-06-25T00:00:00Z" },
      { signal: -1, closedAt: "2026-06-26T00:00:00Z" }, // latest
    ]);
    expect(t.lastSign).toBe(-1);
  });

  it("treats zero reward as neither positive nor negative", () => {
    const t = tallyOutcomes([{ signal: 0, closedAt: "2026-06-26T00:00:00Z" }]);
    expect(t.netPositive).toBe(0);
    expect(t.lastSign).toBe(0);
  });

  it("returns an empty tally for no rows", () => {
    expect(tallyOutcomes([])).toEqual({ netPositive: 0, lastSign: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/calibration/__tests__/outcomes.test.ts`
Expected: FAIL — cannot find module `../outcomes`.

- [ ] **Step 3: Write the implementation**

```ts
// Pure outcome-tally math for Calderyn Calibration (design 2026-06-26 §2.1/§4).
// NO I/O, NO .server import: shared by the recompute job, the live gate, and any
// UI that wants to show "made money N of M times". A "measured outcome" is the
// sign of a closed-window reward_signal persisted on action_audit by the engine.

export interface OutcomeRow {
  /** Signed reward_signal: >0 helped, <0 hurt (undo = -100), 0 = no opinion. */
  signal: number;
  /** reward_window_closed_at ISO string; used only to pick the most recent sign. */
  closedAt: string;
}

export interface OutcomeTally {
  /** max(0, #positive − #negative). The bar in graduationVerdict compares this. */
  netPositive: number;
  /** Sign of the most recently closed outcome. Drives outcome demotion. */
  lastSign: -1 | 0 | 1;
}

const signOf = (n: number): -1 | 0 | 1 => (n > 0 ? 1 : n < 0 ? -1 : 0);

export function tallyOutcomes(rows: OutcomeRow[]): OutcomeTally {
  let pos = 0;
  let neg = 0;
  let latestAt = "";
  let lastSign: -1 | 0 | 1 = 0;
  for (const r of rows) {
    const s = signOf(r.signal);
    if (s > 0) pos++;
    else if (s < 0) neg++;
    if (r.closedAt > latestAt) {
      latestAt = r.closedAt;
      lastSign = s;
    }
  }
  return { netPositive: Math.max(0, pos - neg), lastSign };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/calibration/__tests__/outcomes.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/calibration/outcomes.ts app/lib/calibration/__tests__/outcomes.test.ts
git commit -m "calibration: pure outcome-tally helper"
```

---

### Task 6: TS pure — outcome gate + demotion in `graduationVerdict`

**Files:**
- Modify: `app/lib/calibration/graduation.ts`
- Test: `app/lib/calibration/__tests__/graduation-outcomes.test.ts`

**Interfaces:**
- Consumes: nothing new (pure).
- Produces: `GraduationVerdictInput` gains `netPositiveOutcomes: number` and `lastOutcomeSign: -1 | 0 | 1`; exports `MIN_OUTCOMES = { reversible: 3, hard_to_reverse: 5, irreversible: 8 }`. New gates: a measured-loss demotion (`lastOutcomeSign < 0` → not graduated, applies even to no-brainers) and an outcome bar (`netPositiveOutcomes < MIN_OUTCOMES[tier]` → not graduated, after the no-brainer exemption). Consumed by Tasks 8, 9.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { graduationVerdict, MIN_OUTCOMES } from "../graduation";

const base = {
  detectorId: "campaign_below_breakeven",
  actionKind: "reduce_campaign_budget" as const,
  lastConf: 90,
  gradThreshold: 75,
  cleanApprovals: 10,
  consecutiveUndos: 0,
  merchantDisabled: false,
  onProbation: false,
  hasUndoBranch: true,
  netPositiveOutcomes: 5,
  lastOutcomeSign: 1 as -1 | 0 | 1,
};

describe("graduationVerdict outcome gating", () => {
  it("graduates when both bars are met", () => {
    expect(graduationVerdict(base).graduated).toBe(true);
  });

  it("blocks when measured outcomes are below the bar", () => {
    const v = graduationVerdict({ ...base, netPositiveOutcomes: 1 });
    expect(v.graduated).toBe(false);
    expect(v.reason).toMatch(/proven/i);
  });

  it("demotes on a recent measured loss even with enough approvals", () => {
    const v = graduationVerdict({ ...base, lastOutcomeSign: -1 });
    expect(v.graduated).toBe(false);
    expect(v.reason).toMatch(/loss/i);
  });

  it("exempts no-brainers from the outcome BAR but not from loss demotion", () => {
    const nb = {
      ...base,
      detectorId: "campaign_below_breakeven",
      actionKind: "pause_campaign" as const,
      netPositiveOutcomes: 0, // below bar, but no-brainer is exempt
    };
    expect(graduationVerdict(nb).graduated).toBe(true);
    // ...until a measured loss lands:
    expect(graduationVerdict({ ...nb, lastOutcomeSign: -1 }).graduated).toBe(false);
  });

  it("exposes the per-tier outcome minimums", () => {
    expect(MIN_OUTCOMES.reversible).toBe(3);
    expect(MIN_OUTCOMES.hard_to_reverse).toBe(5);
    expect(MIN_OUTCOMES.irreversible).toBe(8);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/calibration/__tests__/graduation-outcomes.test.ts`
Expected: FAIL — `MIN_OUTCOMES` is not exported / `netPositiveOutcomes` unused.

- [ ] **Step 3: Edit `graduation.ts`**

Add the constant beside `MIN_APPROVALS`:

```ts
/** Minimum net-positive MEASURED outcomes required per reversibility class
 *  (design 2026-06-26 §2.1). The second of the two graduation bars. */
export const MIN_OUTCOMES = {
  reversible: 3,
  hard_to_reverse: 5,
  irreversible: 8,
} as const;
```

Extend the input interface:

```ts
export interface GraduationVerdictInput {
  detectorId: string;
  actionKind: ActionKind;
  lastConf: number;
  gradThreshold: number;
  cleanApprovals: number;
  consecutiveUndos: number;
  merchantDisabled: boolean;
  onProbation: boolean;
  hasUndoBranch: boolean;
  /** Net-positive measured outcomes (design §2.1). 0 until windows close. */
  netPositiveOutcomes: number;
  /** Sign of the most recently closed outcome (design §2.3). <0 demotes. */
  lastOutcomeSign: -1 | 0 | 1;
}
```

In `graduationVerdict`, insert the **measured-loss demotion BEFORE the no-brainer
early-return** (so a no-brainer that loses money still demotes), and the
**outcome bar AFTER the no-brainer return and after the approvals gate**:

```ts
  if (input.consecutiveUndos !== 0) {
    return { graduated: false, reason: "recent undo" };
  }
  // Measured-loss demotion (design §2.3): the most recent closed outcome lost
  // money. Applies to ALL pairs, including shipped no-brainers — reality can
  // revoke trust without waiting for a merchant undo.
  if (input.lastOutcomeSign < 0) {
    return { graduated: false, reason: "recent measured loss" };
  }
  if (NO_BRAINER.has(`${input.detectorId}:${input.actionKind}`)) {
    return { graduated: true, reason: "shipped no-brainer" };
  }
  if (input.cleanApprovals < MIN_APPROVALS[actionTier(input.actionKind)]) {
    return { graduated: false, reason: "needs more approvals" };
  }
  // Second bar (design §2.1): the dollars must prove it, not just the clicks.
  if (input.netPositiveOutcomes < MIN_OUTCOMES[actionTier(input.actionKind)]) {
    return { graduated: false, reason: "needs proven results" };
  }
  if (input.lastConf < input.gradThreshold) {
    return { graduated: false, reason: "below confidence bar" };
  }
  return { graduated: true, reason: "all gates passed" };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run app/lib/calibration/__tests__/graduation-outcomes.test.ts app/lib/calibration/__tests__/confidence.test.ts`
Expected: outcome tests PASS. NOTE: existing callers of `graduationVerdict` (recompute.server.ts, graduation.server.ts, and any existing graduation tests) will now fail typecheck for the two missing fields — Tasks 8 & 9 fix the callers. If a pre-existing `graduation` unit test exists, update its fixtures to include `netPositiveOutcomes: 0, lastOutcomeSign: 0` in this step.

- [ ] **Step 5: Commit**

```bash
git add app/lib/calibration/graduation.ts app/lib/calibration/__tests__/graduation-outcomes.test.ts
git commit -m "calibration: outcome bar + measured-loss demotion in graduationVerdict"
```

---

### Task 7: TS server — read per-pair outcome tallies from `action_audit`

**Files:**
- Create: `app/lib/calibration/outcomes.server.ts`
- Test: `app/lib/calibration/__tests__/outcomes-server.test.ts`

**Interfaces:**
- Consumes: `tallyOutcomes` (Task 5); `action_audit.reward_signal` + `reward_window_closed_at` (Task 1/4).
- Produces: `loadPairOutcomeTallies(shopId: string, sb: SupabaseClient): Promise<Map<string, OutcomeTally>>` keyed by `"<detector_id>:<action_kind>"`. NEVER throws — returns an empty Map on read error (fail-safe: no outcome data ⇒ no graduation, never a crash).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { loadPairOutcomeTallies } from "../outcomes.server";

function fakeSb(rows: unknown[], error: unknown = null) {
  // Chain: .from().select().eq().not() -> resolves { data, error }
  const thenable = {
    eq() { return this; },
    not() { return Promise.resolve({ data: rows, error }); },
  };
  return { from: () => ({ select: () => thenable }) } as never;
}

describe("loadPairOutcomeTallies", () => {
  it("groups closed-window rewards into per-pair tallies", async () => {
    const sb = fakeSb([
      { action_kind: "pause_campaign", reward_signal: 10, reward_window_closed_at: "2026-06-20T00:00:00Z", alerts: { detector_id: "campaign_below_breakeven" } },
      { action_kind: "pause_campaign", reward_signal: 5, reward_window_closed_at: "2026-06-21T00:00:00Z", alerts: { detector_id: "campaign_below_breakeven" } },
      { action_kind: "pause_campaign", reward_signal: -100, reward_window_closed_at: "2026-06-22T00:00:00Z", alerts: { detector_id: "campaign_below_breakeven" } },
    ]);
    const m = await loadPairOutcomeTallies("shop1", sb);
    const t = m.get("campaign_below_breakeven:pause_campaign");
    expect(t?.netPositive).toBe(1);
    expect(t?.lastSign).toBe(-1);
  });

  it("returns an empty map on read error (fail-safe)", async () => {
    const sb = fakeSb([], { message: "boom" });
    const m = await loadPairOutcomeTallies("shop1", sb);
    expect(m.size).toBe(0);
  });

  it("skips rows with no detector (null alert join)", async () => {
    const sb = fakeSb([
      { action_kind: "pause_campaign", reward_signal: 10, reward_window_closed_at: "2026-06-20T00:00:00Z", alerts: null },
    ]);
    const m = await loadPairOutcomeTallies("shop1", sb);
    expect(m.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/calibration/__tests__/outcomes-server.test.ts`
Expected: FAIL — cannot find module `../outcomes.server`.

- [ ] **Step 3: Write the implementation**

```ts
// Read closed-window per-action rewards from action_audit and fold them into
// per-(detector, action) outcome tallies. The detector comes from the joined
// alert (action_audit has no detector_id column). Rows with no alert/detector
// cannot map to a calibration pair and are skipped. NEVER throws.

import type { SupabaseClient } from "@supabase/supabase-js";
import { tallyOutcomes, type OutcomeRow, type OutcomeTally } from "./outcomes";

interface AuditRewardRow {
  action_kind: string;
  reward_signal: number | null;
  reward_window_closed_at: string | null;
  alerts: { detector_id: string | null } | null;
}

export async function loadPairOutcomeTallies(
  shopId: string,
  sb: SupabaseClient,
): Promise<Map<string, OutcomeTally>> {
  try {
    const { data, error } = await sb
      .from("action_audit")
      .select("action_kind, reward_signal, reward_window_closed_at, alerts!inner(detector_id)")
      .eq("shop_id", shopId)
      .not("reward_window_closed_at", "is", null);
    if (error) {
      console.error(`[calibration] loadPairOutcomeTallies read failed: ${error.message}`);
      return new Map();
    }
    const byPair = new Map<string, OutcomeRow[]>();
    for (const r of (data ?? []) as unknown as AuditRewardRow[]) {
      const detector = r.alerts?.detector_id;
      if (!detector || r.reward_signal == null || r.reward_window_closed_at == null) continue;
      const key = `${detector}:${r.action_kind}`;
      const arr = byPair.get(key) ?? [];
      arr.push({ signal: Number(r.reward_signal), closedAt: r.reward_window_closed_at });
      byPair.set(key, arr);
    }
    const out = new Map<string, OutcomeTally>();
    for (const [key, rows] of byPair) out.set(key, tallyOutcomes(rows));
    return out;
  } catch (err) {
    console.error(
      `[calibration] loadPairOutcomeTallies threw: ${err instanceof Error ? err.message : String(err)}`,
    );
    return new Map();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/calibration/__tests__/outcomes-server.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/calibration/outcomes.server.ts app/lib/calibration/__tests__/outcomes-server.test.ts
git commit -m "calibration: read per-pair outcome tallies from action_audit"
```

---

### Task 8: TS server — tally + persist outcomes + demote in nightly recompute

**Files:**
- Modify: `app/lib/calibration/recompute.server.ts`
- Test: `app/lib/calibration/__tests__/recompute-outcomes.test.ts`

**Interfaces:**
- Consumes: `loadPairOutcomeTallies` (Task 7), the extended `graduationVerdict` (Task 6), the new `pair_calibration` columns (Task 1).
- Produces: each recompute now (a) loads outcome tallies once, (b) passes `netPositiveOutcomes`/`lastOutcomeSign` into the verdict, and (c) writes `net_positive_outcomes` + `last_outcome_sign` alongside `graduated`/`last_conf`. A graduated pair whose `lastOutcomeSign < 0` is written back `graduated = false` (demotion).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { recomputeShopCalibration } from "../recompute.server";

// This test asserts the verdict receives the outcome fields. We spy on the
// pair_calibration update payload to confirm net_positive_outcomes is written.
// (Use the repo's existing recompute test harness/mocks as the template — this
//  test adds one assertion path; reuse its fake SupabaseClient builder.)

it("writes net_positive_outcomes from the action_audit tally", async () => {
  // Arrange a shop with one graduated-eligible pair that has 5 positive outcomes.
  // Build the fake sb so:
  //   - pair_calibration select returns one row with clean_approvals=10
  //   - action_audit select (via loadPairOutcomeTallies) returns 5 positive rewards
  //   - capture the pair_calibration .update() payload
  // Assert the captured payload includes net_positive_outcomes: 5.
  // (Full fake wiring mirrors __tests__/recompute.test.ts.)
  expect(true).toBe(true); // replace with the asserted update payload per harness
});
```

> Implementer note: the repo already has `app/lib/calibration/__tests__/recompute.test.ts`. Copy its fake-`SupabaseClient` builder and extend it to (1) answer the `action_audit` select used by `loadPairOutcomeTallies`, (2) capture the `pair_calibration` update payload. The real assertion is `payload.net_positive_outcomes === 5` and, for a demotion case, `payload.graduated === false` when the latest reward is negative.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/calibration/__tests__/recompute-outcomes.test.ts`
Expected: FAIL once the real assertion is in place (net_positive_outcomes not yet written).

- [ ] **Step 3: Edit `recompute.server.ts`**

Add the import:

```ts
import { loadPairOutcomeTallies } from "./outcomes.server";
```

Extend the `pair_calibration` select to include the new columns:

```ts
    .select(
      "detector_id, action_kind, alpha, beta, clean_approvals, consecutive_undos, merchant_disabled, graduation_threshold, net_positive_outcomes, last_outcome_sign",
    )
```

Load tallies once, right after the `pairMap` is built:

```ts
  // Per-pair measured-outcome tallies from closed-window action_audit rewards.
  // Fail-safe: an empty map (read error / no data) means every pair sees 0
  // outcomes → no graduation on clicks alone, never a crash.
  const outcomeTallies = await loadPairOutcomeTallies(shopId, sb);
```

In the scoring loop, where `verdict` is computed for an existing `ev`, source the
outcome fields from the tally (fall back to the stored row, then 0):

```ts
      const tally = outcomeTallies.get(key);
      const netPositiveOutcomes = tally?.netPositive ?? 0;
      const lastOutcomeSign = tally?.lastSign ?? 0;
      const verdict = graduationVerdict({
        detectorId: detector,
        actionKind: action as ActionKind,
        lastConf: conf,
        gradThreshold: ev.graduation_threshold,
        cleanApprovals: ev.clean_approvals,
        consecutiveUndos: ev.consecutive_undos,
        merchantDisabled: ev.merchant_disabled,
        onProbation: false,
        hasUndoBranch: HAS_UNDO_BRANCH.has(action as ActionKind),
        netPositiveOutcomes,
        lastOutcomeSign,
      });
```

And extend the update payload to persist the tally:

```ts
      const { error: pairUpdErr } = await sb
        .from("pair_calibration")
        .update({
          graduated: verdict.graduated,
          last_conf: Math.round(conf),
          net_positive_outcomes: netPositiveOutcomes,
          last_outcome_sign: lastOutcomeSign,
          updated_at: new Date().toISOString(),
        })
        .eq("shop_id", shopId)
        .eq("detector_id", detector)
        .eq("action_kind", action);
```

Also add `net_positive_outcomes` and `last_outcome_sign` to the `pairMap` value
type and its population (default 0) so the types line up.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run app/lib/calibration/__tests__/recompute-outcomes.test.ts app/lib/calibration/__tests__/recompute.test.ts`
Expected: PASS (existing recompute test still green; new outcome test green).

- [ ] **Step 5: Commit**

```bash
git add app/lib/calibration/recompute.server.ts app/lib/calibration/__tests__/recompute-outcomes.test.ts
git commit -m "calibration: tally + persist + demote outcomes in nightly recompute"
```

---

### Task 9: TS server — live gate reads the persisted outcome tally

**Files:**
- Modify: `app/lib/calibration/graduation.server.ts`
- Test: `app/lib/calibration/__tests__/graduation-server-outcomes.test.ts`

**Interfaces:**
- Consumes: the `pair_calibration` outcome columns (Task 1, populated by Task 8).
- Produces: `isGraduated` and `countNearGraduation` pass `netPositiveOutcomes`/`lastOutcomeSign` (read from the row) into `graduationVerdict`. The live gate stays a single cheap row read — it trusts the nightly-persisted tally rather than re-scanning `action_audit`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { isGraduated } from "../graduation.server";

function sbWithPair(row: Record<string, unknown>) {
  const pairSingle = { maybeSingle: () => Promise.resolve({ data: row, error: null }) };
  const pairChain = { eq: () => pairChain, ...pairSingle };
  const ruleChain = { eq: () => ruleChain, then: undefined as never };
  // calibration_rule select resolves to [] (no rules)
  const ruleResolved = { eq: () => ruleResolved };
  return {
    from(table: string) {
      if (table === "pair_calibration") return { select: () => pairChain };
      return { select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }) }) }) };
    },
  } as never;
}

describe("isGraduated outcome gate", () => {
  it("stays non-graduated when proven results are below the bar", async () => {
    const ok = await isGraduated("s", "campaign_below_breakeven", "reduce_campaign_budget",
      sbWithPair({ last_conf: 90, graduation_threshold: 75, clean_approvals: 10, consecutive_undos: 0, merchant_disabled: false, net_positive_outcomes: 1, last_outcome_sign: 1 }));
    expect(ok).toBe(false);
  });

  it("graduates when both bars and confidence are met", async () => {
    const ok = await isGraduated("s", "campaign_below_breakeven", "reduce_campaign_budget",
      sbWithPair({ last_conf: 90, graduation_threshold: 75, clean_approvals: 10, consecutive_undos: 0, merchant_disabled: false, net_positive_outcomes: 5, last_outcome_sign: 1 }));
    expect(ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/calibration/__tests__/graduation-server-outcomes.test.ts`
Expected: FAIL (verdict currently called without the outcome fields → typecheck/behavior).

- [ ] **Step 3: Edit `graduation.server.ts`**

In `isGraduated`, extend the select and verdict call:

```ts
      .select(
        "last_conf, graduation_threshold, clean_approvals, consecutive_undos, merchant_disabled, net_positive_outcomes, last_outcome_sign",
      )
```

```ts
    const verdict = graduationVerdict({
      detectorId,
      actionKind,
      lastConf: Number(row.last_conf ?? 0),
      gradThreshold: Number(row.graduation_threshold ?? 100),
      cleanApprovals: Number(row.clean_approvals ?? 0),
      consecutiveUndos: Number(row.consecutive_undos ?? 0),
      merchantDisabled: Boolean(row.merchant_disabled) || mutedByRule,
      onProbation,
      hasUndoBranch,
      netPositiveOutcomes: Number(row.net_positive_outcomes ?? 0),
      lastOutcomeSign: Number(row.last_outcome_sign ?? 0) as -1 | 0 | 1,
    });
```

In `countNearGraduation`, add `net_positive_outcomes, last_outcome_sign` to its
select, and where it currently checks proximity, also require the outcome bar so
"near graduation" stays honest:

```ts
      const tier = actionTier(action);                         // import from confidence
      if (Number(row.net_positive_outcomes ?? 0) < MIN_OUTCOMES[tier]) continue;
      if (Number(row.last_outcome_sign ?? 0) < 0) continue;
```

Add the imports: `import { actionTier } from "./confidence";` and `MIN_OUTCOMES` from `./graduation`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run app/lib/calibration/__tests__/graduation-server-outcomes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/calibration/graduation.server.ts app/lib/calibration/__tests__/graduation-server-outcomes.test.ts
git commit -m "calibration: live gate consumes persisted outcome tally"
```

---

### Task 10: Finish undo→demote (increment `consecutive_undos`)

**Files:**
- Create: `supabase/migrations/20260626120100_calibration_record_undo_fn.sql` (+ engine mirror)
- Modify: `app/lib/actions/undo.server.ts`
- Test: `app/lib/actions/__tests__/undo-demote.test.ts`

**Interfaces:**
- Consumes: `pair_calibration` (existing). The undo path already loads the original audit row with `alert_id`.
- Produces: `calibration_record_undo(p_shop_id uuid, p_detector_id text, p_action_kind public.action_kind)` RPC that sets `consecutive_undos = consecutive_undos + 1` and `consecutive_clean_approvals = 0`. `undoAction` calls it after a successful undo of an `actor_user_id='autopilot'` original, resolving the detector from the original's alert.

- [ ] **Step 1: Write the RPC migration**

```sql
-- Atomic negative signal: a merchant undid an autopilot action. Bump the pair's
-- consecutive_undos (graduation gate 5) and reset the clean-approval streak.
-- SECURITY DEFINER, service_role-only, mirrors calibration_record_approval.
create or replace function public.calibration_record_undo(
  p_shop_id uuid,
  p_detector_id text,
  p_action_kind public.action_kind
) returns void
language sql
security definer
set search_path = ''
as $func$
  insert into public.pair_calibration (shop_id, detector_id, action_kind, consecutive_undos, consecutive_clean_approvals, updated_at)
  values (p_shop_id, p_detector_id, p_action_kind, 1, 0, now())
  on conflict (shop_id, detector_id, action_kind) do update
    set consecutive_undos = public.pair_calibration.consecutive_undos + 1,
        consecutive_clean_approvals = 0,
        updated_at = now();
$func$;

revoke all on function public.calibration_record_undo(uuid, text, public.action_kind) from public;
revoke execute on function public.calibration_record_undo(uuid, text, public.action_kind) from anon, authenticated;
grant execute on function public.calibration_record_undo(uuid, text, public.action_kind) to service_role;
```

Copy the same body to `tests/engine/schema/migrations/20260626120100_calibration_record_undo_fn.sql`.

- [ ] **Step 2: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { undoAction } from "../undo.server";

it("records an undo signal when an autopilot action is reversed", async () => {
  const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
  // Build a fake sb whose action_audit load returns a succeeded pause_campaign
  // original with actor_user_id='autopilot' and alert_id='al1', whose alerts
  // load returns detector_id='campaign_below_breakeven', and capture rpc args.
  // (Reuse the fake-sb builder from __tests__/undo.test.ts.)
  // After undoAction(...), assert:
  expect(rpc).toHaveBeenCalledWith("calibration_record_undo", {
    p_shop_id: "shop1",
    p_detector_id: "campaign_below_breakeven",
    p_action_kind: "pause_campaign",
  });
});
```

> Implementer note: `app/lib/actions/__tests__/undo.test.ts` already exercises `undoAction` with a fake SupabaseClient. Extend that fake to answer an `alerts` select (`detector_id`) and to record `.rpc()` calls.

- [ ] **Step 3: Edit `undo.server.ts`**

After the undo row is successfully inserted (the `ins` insert near the end) and
the alert is re-opened, add — only for autopilot-originated actions:

```ts
  // Record the undo as a negative calibration signal (graduation gate 5). Only
  // autopilot actions feed trust; a merchant undoing their OWN click is not a
  // veto of autonomy. Best-effort: log, never fail the recorded undo.
  if (String(orig.actor_user_id ?? "") === "autopilot" && orig.alert_id) {
    const { data: al } = await sb
      .from("alerts")
      .select("detector_id")
      .eq("shop_id", shopId)
      .eq("id", orig.alert_id)
      .maybeSingle();
    const detectorId = al?.detector_id ?? null;
    if (detectorId) {
      const { error: undoSigErr } = await sb.rpc("calibration_record_undo", {
        p_shop_id: shopId,
        p_detector_id: detectorId,
        p_action_kind: orig.action_kind,
      });
      if (undoSigErr) {
        console.error(`[undo] calibration_record_undo failed for ${detectorId}:${orig.action_kind}`, undoSigErr);
      }
    }
  }
```

- [ ] **Step 4: Run tests + apply migration**

Run: `psql "$DATABASE_URL" -f supabase/migrations/20260626120100_calibration_record_undo_fn.sql`
Run: `npx vitest run app/lib/actions/__tests__/undo-demote.test.ts app/lib/actions/__tests__/undo.test.ts`
Expected: PASS (existing undo test green; new demote test green).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260626120100_calibration_record_undo_fn.sql tests/engine/schema/migrations/20260626120100_calibration_record_undo_fn.sql app/lib/actions/undo.server.ts app/lib/actions/__tests__/undo-demote.test.ts
git commit -m "calibration: increment consecutive_undos on autopilot undo (finish undo->demote)"
```

---

### Task 11: Surface the two-bar progress (both surfaces)

**Files:**
- Modify: `app/lib/calibration/live-engine-types.ts` (VM contract — shared by both surfaces)
- Create: `app/lib/calibration/progress.ts` (pure two-bar progress helper)
- Modify: `app/lib/calibration/live-engine-page.server.ts` (populate the new VM fields)
- Modify: `app/lib/calderyn.server.ts` (`calibration.liveEngine` / `pairEvidence` select — add the columns)
- Modify: `app/components/dashboard/screens/LiveEngine.tsx` (dashboard render)
- Modify: `app/components/calderyn/` Live Engine component (embedded render — the file `app/routes/app.engine.tsx` renders)
- Test: `app/lib/calibration/__tests__/progress.test.ts`

**Interfaces:**
- Consumes: `MIN_APPROVALS`, `MIN_OUTCOMES`, `actionTier` (graduation.ts/confidence.ts); the per-pair `clean_approvals` + `net_positive_outcomes` columns.
- Produces:
  - `LiveEngineFeatureVM` gains `approvals: number`, `approvalsNeeded: number`, `outcomes: number`, `outcomesNeeded: number`, `proven: boolean`.
  - `graduationProgress(actionKind, cleanApprovals, netPositiveOutcomes): { approvals; approvalsNeeded; outcomes; outcomesNeeded; proven }` in `progress.ts`.

- [ ] **Step 1: Write the failing test for the pure helper**

```ts
import { describe, it, expect } from "vitest";
import { graduationProgress } from "../progress";

describe("graduationProgress", () => {
  it("reports both bars for a reversible action", () => {
    const p = graduationProgress("pause_campaign", 2, 1);
    expect(p).toEqual({
      approvals: 2, approvalsNeeded: 3, outcomes: 1, outcomesNeeded: 3, proven: false,
    });
  });

  it("is proven only when BOTH bars are met", () => {
    expect(graduationProgress("pause_campaign", 3, 3).proven).toBe(true);
    expect(graduationProgress("pause_campaign", 3, 2).proven).toBe(false);
    expect(graduationProgress("pause_campaign", 2, 3).proven).toBe(false);
  });

  it("uses the harder bars for hard_to_reverse kinds", () => {
    const p = graduationProgress("discontinue_sku", 0, 0);
    expect(p.approvalsNeeded).toBe(10);
    expect(p.outcomesNeeded).toBe(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/calibration/__tests__/progress.test.ts`
Expected: FAIL — cannot find module `../progress`.

- [ ] **Step 3: Write the pure helper**

```ts
// Pure two-bar graduation progress for merchant-facing display. Combines the
// approval bar (MIN_APPROVALS) and the measured-outcome bar (MIN_OUTCOMES) so
// both surfaces render "approved X/N AND made money Y/M" identically.
import type { ActionKind } from "../types";
import { actionTier } from "./confidence";
import { MIN_APPROVALS, MIN_OUTCOMES } from "./graduation";

export interface GraduationProgress {
  approvals: number;
  approvalsNeeded: number;
  outcomes: number;
  outcomesNeeded: number;
  /** Both bars met (confidence/undo/probation gates handled elsewhere). */
  proven: boolean;
}

export function graduationProgress(
  actionKind: ActionKind,
  cleanApprovals: number,
  netPositiveOutcomes: number,
): GraduationProgress {
  const tier = actionTier(actionKind);
  const approvalsNeeded = MIN_APPROVALS[tier];
  const outcomesNeeded = MIN_OUTCOMES[tier];
  const approvals = Math.max(0, cleanApprovals);
  const outcomes = Math.max(0, netPositiveOutcomes);
  return {
    approvals,
    approvalsNeeded,
    outcomes,
    outcomesNeeded,
    proven: approvals >= approvalsNeeded && outcomes >= outcomesNeeded,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/calibration/__tests__/progress.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Extend the VM contract**

In `live-engine-types.ts`, add to `LiveEngineFeatureVM`:

```ts
  /** Two-bar graduation progress (design §2.1). */
  approvals: number;
  approvalsNeeded: number;
  outcomes: number;
  outcomesNeeded: number;
  proven: boolean;
```

- [ ] **Step 6: Populate the fields in the page builder**

In `calderyn.server.ts`, the `calibration.liveEngine()` feature rows and/or
`calibration.pairEvidence()` must carry `cleanApprovals` and `netPositiveOutcomes`
— extend the underlying `pair_calibration` select to include
`clean_approvals, net_positive_outcomes` (they are already on the table). Then in
`buildLiveEnginePageData`, map them through:

```ts
import { graduationProgress } from "./progress";
```

```ts
    const features: LiveEngineFeatureVM[] = (summary?.features ?? []).map((f) => {
      const prog = graduationProgress(f.actionKind, f.cleanApprovals ?? 0, f.netPositiveOutcomes ?? 0);
      return {
        detectorId: f.detectorId,
        actionKind: f.actionKind,
        name: f.name,
        watching: f.watching,
        enabled: f.enabled,
        moneyCents: f.moneyCents,
        actions: f.actions,
        lastAt: f.lastAt,
        lastText: f.lastAt ? `last acted ${relTime(f.lastAt, now)}` : "no actions yet",
        ...prog,
      };
    });
```

(Add `cleanApprovals`/`netPositiveOutcomes` to the feature shape returned by
`client.calibration.liveEngine()`; mirror the EMPTY/default to 0.)

- [ ] **Step 7: Render on both surfaces**

Dashboard (`app/components/dashboard/screens/LiveEngine.tsx`) — in the feature card,
below the existing money/last-acted line, add a plain-language two-bar line:

```tsx
{!f.proven && (
  <p className="cd-feature-progress">
    Approved {f.approvals}/{f.approvalsNeeded} · made money {f.outcomes}/{f.outcomesNeeded}
    {" "}— a few more good results and it can run on its own
  </p>
)}
```

Embedded (the Live Engine component under `app/components/calderyn/` rendered by
`app/routes/app.engine.tsx`) — add the Polaris equivalent (a `Text` subdued line)
carrying the same numbers. Same data, surface-native primitives (no Polaris JSX
copied into the dashboard, no Lucide in the embedded app).

- [ ] **Step 8: Run typecheck + the calibration tests**

Run: `npm run typecheck` then `npx vitest run app/lib/calibration`
Expected: typecheck exit 0; all calibration tests PASS.

- [ ] **Step 9: Commit**

```bash
git add app/lib/calibration/progress.ts app/lib/calibration/__tests__/progress.test.ts app/lib/calibration/live-engine-types.ts app/lib/calibration/live-engine-page.server.ts app/lib/calderyn.server.ts app/components/dashboard/screens/LiveEngine.tsx app/components/calderyn app/routes/app.engine.tsx
git commit -m "calibration: surface two-bar (approvals + proven results) progress on both surfaces"
```

---

### Task 12: Phase 1 verification gate

**Files:** none (verification only).

- [ ] **Step 1: Full eval pipeline**

Run, in order, and paste output (do not assert success without evidence):
- `npm run typecheck` → exit 0
- `npm run lint` → exit 0 (no warnings on touched files)
- `npm run build` → exit 0
- `npx vitest run app/lib/calibration app/lib/actions` → all PASS
- `pytest tests/engine/moat -q` → all PASS

- [ ] **Step 2: `/code-review` the working tree**

Resolve every blocker; downgrade nits with a one-line justification.

- [ ] **Step 3: Behavioral check on the review store (testing-on-prod)**

With `pair_calibration` seeded for `calderyn-review-store`, confirm: a pair with
enough approvals but `net_positive_outcomes = 0` shows as NOT graduated; after
seeding 3 positive closed-window `action_audit` rewards and running
`cron.calibration-recompute`, the same pair flips to graduated; seeding a negative
latest reward demotes it on the next recompute.

- [ ] **Step 4: Tag the phase**

```bash
git tag phase1-outcome-gated-autonomy
```

---

# PHASE 2 — Expand the graduatable set 3→7

Builds an outcome metric for each of the four new kinds, adds the price/inventory bounded-magnitude caps, then flips the four into `GRADUATABLE`. Depends on all of Phase 1.

### Task 13: Centralize `HAS_UNDO_BRANCH` (remove drift) + add `adjust_price`

**Files:**
- Create: `app/lib/calibration/undo-branches.ts`
- Modify: `app/lib/calibration/graduation.server.ts`, `app/lib/calibration/recompute.server.ts`
- Test: `app/lib/calibration/__tests__/undo-branches.test.ts`

**Interfaces:**
- Produces: `HAS_UNDO_BRANCH: ReadonlySet<ActionKind>` — the SINGLE definition. Replaces the two drifting copies (recompute's set was even missing `discontinue_sku`). Includes `adjust_price`.

> Why this matters: today `graduation.server.ts` and `recompute.server.ts` each hard-code their own `HAS_UNDO_BRANCH`, and they already disagree (recompute omits `discontinue_sku`). A single source prevents a pair being "graduatable" in the nightly cache but not the live gate.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { HAS_UNDO_BRANCH } from "../undo-branches";

describe("HAS_UNDO_BRANCH", () => {
  it("includes every kind with an undo branch in undo.server.ts", () => {
    for (const k of ["pause_campaign", "resume_campaign", "reduce_campaign_budget",
                     "reallocate_budget", "reallocate_inventory", "discontinue_sku",
                     "adjust_price"] as const) {
      expect(HAS_UNDO_BRANCH.has(k)).toBe(true);
    }
  });
  it("excludes kinds with no undo branch", () => {
    expect(HAS_UNDO_BRANCH.has("increase_campaign_budget")).toBe(false);
    expect(HAS_UNDO_BRANCH.has("create_po_draft")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/calibration/__tests__/undo-branches.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module and delete the copies**

```ts
// Single source of truth for action kinds with a working undo branch in
// app/lib/actions/undo.server.ts. Graduation gate 2 (I7) requires this — a pair
// can only act unattended if Calderyn can take the action back. Keep in lockstep
// with undo.server.ts's reversal branches.
import type { ActionKind } from "../types";

export const HAS_UNDO_BRANCH: ReadonlySet<ActionKind> = new Set<ActionKind>([
  "pause_campaign",
  "resume_campaign",
  "reduce_campaign_budget",
  "reallocate_budget",
  "reallocate_inventory",
  "discontinue_sku",
  "adjust_price",
]);
```

In `graduation.server.ts` and `recompute.server.ts`: delete the local
`HAS_UNDO_BRANCH` const and `import { HAS_UNDO_BRANCH } from "./undo-branches";`.

- [ ] **Step 4: Run typecheck + tests**

Run: `npm run typecheck && npx vitest run app/lib/calibration`
Expected: exit 0; all PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/calibration/undo-branches.ts app/lib/calibration/graduation.server.ts app/lib/calibration/recompute.server.ts app/lib/calibration/__tests__/undo-branches.test.ts
git commit -m "calibration: single HAS_UNDO_BRANCH source (+ adjust_price); fix nightly/live drift"
```

---

### Task 14: `adjust_price` reversibility tier

**Files:**
- Modify: `app/lib/calibration/confidence.ts`
- Test: `app/lib/calibration/__tests__/confidence.test.ts` (extend)

**Interfaces:**
- Produces: `actionTier("adjust_price") === "hard_to_reverse"` (was defaulting to `irreversible`). Sets its bars to 10 approvals / 5 outcomes (design §2.4).

- [ ] **Step 1: Add the failing assertion**

```ts
it("treats adjust_price as hard_to_reverse (customer-visible but undoable)", () => {
  expect(actionTier("adjust_price")).toBe("hard_to_reverse");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/lib/calibration/__tests__/confidence.test.ts`
Expected: FAIL (currently `irreversible`).

- [ ] **Step 3: Edit `ACTION_TIER`**

Add to the `ACTION_TIER` map in `confidence.ts`:

```ts
  // Customer-visible but reversible via its undo branch (re-set the prior price).
  adjust_price: "hard_to_reverse",
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run app/lib/calibration/__tests__/confidence.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/calibration/confidence.ts app/lib/calibration/__tests__/confidence.test.ts
git commit -m "calibration: adjust_price is hard_to_reverse (10 approvals / 5 outcomes)"
```

---

### Task 15: Engine — reward branch for `resume_campaign` (campaign-scoped)

**Files:**
- Modify: `engine/calderyn_engine/moat/action_rewards.py`
- Test: `tests/engine/moat/test_action_rewards_resume.py`

**Interfaces:**
- Consumes: the existing campaign ROAS/profit inputs (resume is campaign-scoped, so the current `derive_action_reward_inputs` already feeds it).
- Produces: `compute_action_reward("resume_campaign", ...)` returns a profit-delta reward, penalized if the resumed campaign runs below break-even.

- [ ] **Step 1: Write the failing test**

```python
from decimal import Decimal
from calderyn_engine.moat.action_rewards import compute_action_reward


def test_resume_credits_profit_when_above_breakeven():
    # Resumed a campaign; post profit > pre, ROAS above break-even -> positive.
    r = compute_action_reward("resume_campaign", Decimal("3"), Decimal("3"),
                              0, 5000, Decimal("2"), False)
    assert r == Decimal("50")  # +$50 profit delta


def test_resume_penalizes_when_below_breakeven():
    # Resumed but it runs below break-even -> the "gain" is treated as a loss.
    r = compute_action_reward("resume_campaign", Decimal("3"), Decimal("1"),
                              0, 5000, Decimal("2"), False)
    assert r < 0


def test_resume_undo_is_hard_negative():
    r = compute_action_reward("resume_campaign", Decimal("3"), Decimal("3"),
                              0, 5000, Decimal("2"), True)
    assert r == Decimal("-100")
```

- [ ] **Step 2: Run to verify it fails**

Run: `pytest tests/engine/moat/test_action_rewards_resume.py -v`
Expected: FAIL (returns 0 — `resume_campaign` is an unknown kind today).

- [ ] **Step 3: Edit the kernel**

In `action_rewards.py`, add `resume_campaign` to the growth branch (it mirrors
`increase_campaign_budget`'s "penalize scaling into diminishing returns"):

```python
    if action_kind in ("increase_campaign_budget", "reallocate_budget", "resume_campaign"):
        delta = Decimal(post_profit_cents - pre_profit_cents) / 100
        # Penalise growth that runs below break-even: if post ROAS fell below BE,
        # the profit delta is treated as the loss it is.
        if action_kind in ("increase_campaign_budget", "resume_campaign") and post_roas < break_even_roas:
            return delta if delta < 0 else -delta
        return delta
```

- [ ] **Step 4: Run to verify it passes**

Run: `pytest tests/engine/moat/test_action_rewards_resume.py tests/engine/moat/test_autopilot_train_core.py -q`
Expected: PASS (new tests green; existing kernel tests unaffected).

- [ ] **Step 5: Commit**

```bash
git add engine/calderyn_engine/moat/action_rewards.py tests/engine/moat/test_action_rewards_resume.py
git commit -m "engine/moat: reward branch for resume_campaign (penalize below-breakeven)"
```

---

### Task 16: Engine — SKU-scoped reward path (discontinue_sku, adjust_price, reallocate_inventory)

> **Highest-risk task — read first.** The existing reward path is campaign-scoped
> (`_ACTIONS_SQL` reads `params->>'campaign_id'`, `_SPEND_SQL` reads `ad_spend_fact`).
> These three kinds are SKU/variant/location-scoped with no campaign. They need a
> SEPARATE input derivation reading SKU economics, plus new kernel branches. Step 0
> is a data-availability spike — do NOT write the metric until the data is confirmed.

**Files:**
- Create: `engine/calderyn_engine/moat/sku_action_rewards.py` (kernel branches)
- Create: `engine/calderyn_engine/moat/sku_reward_inputs.py` (SKU-scoped derivation)
- Modify: `engine/calderyn_engine/moat/persist_action_rewards.py` (also persist SKU-action rewards)
- Test: `tests/engine/moat/test_sku_action_rewards.py`, `tests/engine/moat/test_sku_reward_inputs.py`

**Interfaces:**
- Produces:
  - `compute_sku_action_reward(action_kind, pre_unit_econ_cents, post_unit_econ_cents, units, undone) -> Decimal` for `discontinue_sku` and `adjust_price`.
  - `compute_inventory_reward(units_sold_dest_post, unit_margin_cents, source_stockout_units, undone) -> Decimal` for `reallocate_inventory`.
  - `derive_sku_action_reward_inputs(conn, shop_id, run_date) -> list[ActionRewardInput]` — same TypedDict, `campaign_id` left "" for SKU actions, `window_closed` per Task 2.

- [ ] **Step 0: Data-availability spike (write findings into the test file as comments)**

Run these against prod (`ajgrmnvzxfxxlwrxcgnu`, testing-on-prod is allowed) and record actual column availability:
- `discontinue_sku` / `adjust_price` audit rows: confirm `params` carries `sku_id` (and `variant_id`, `prior_price_cents` for price) — seen in `undo.server.ts` branches.
- SKU economics over a window: confirm `order_line_fact(sku_id, quantity, price_cents, unit_cost_cents_snapshot)` joined to `order_fact(created_at_source)` (used by `negative_unit_economics.py`).
- Inventory sell-through: confirm `inventory_level_fact(sku_id, location_id, available, observed_at)` and that destination location id is in the audit `params` (`to_location_id`, seen in `undo.server.ts`).
If any required field is absent, STOP and raise it (rule 12) — do not invent a metric over data that isn't there.

- [ ] **Step 1: Write the failing kernel test**

```python
from decimal import Decimal
from calderyn_engine.moat.sku_action_rewards import (
    compute_sku_action_reward, compute_inventory_reward,
)


def test_discontinue_credits_averted_bleed():
    # SKU was net -$3/unit over 200 units; discontinuing stops that bleed.
    r = compute_sku_action_reward("discontinue_sku", -300, 0, 200, False)
    assert r == Decimal("600")  # 200 units * $3 averted


def test_discontinue_penalizes_killing_a_profitable_sku():
    r = compute_sku_action_reward("discontinue_sku", 150, 0, 200, False)
    assert r < 0  # it was profitable; killing it was wrong


def test_adjust_price_credits_profit_improvement():
    # Per-unit economics rose from $5 to $8 over 100 units -> +$300.
    r = compute_sku_action_reward("adjust_price", 500, 800, 100, False)
    assert r == Decimal("300")


def test_inventory_reward_credits_dest_sales_net_of_source_stockout():
    # 40 units sold at dest * $5 margin - 10 source-stockout units * $5 = $150.
    r = compute_inventory_reward(40, 500, 10, False)
    assert r == Decimal("150")


def test_sku_undo_is_hard_negative():
    assert compute_sku_action_reward("adjust_price", 500, 800, 100, True) == Decimal("-100")
    assert compute_inventory_reward(40, 500, 10, True) == Decimal("-100")
```

- [ ] **Step 2: Run to verify it fails**

Run: `pytest tests/engine/moat/test_sku_action_rewards.py -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the SKU kernel**

```python
"""SKU/variant/location-scoped reward kernels for the Phase-2 graduatable actions
(design 2026-06-26 §5b). Same sign convention as compute_action_reward: positive =
helped, undo = -100 hard negative. No I/O.

Unit economics are in cents per unit (margin minus attributable CAC), the same
quantity negative_unit_economics.py computes. Profit/bleed are scaled to dollars.
"""
from __future__ import annotations
from decimal import Decimal

UNDO_PENALTY: Decimal = Decimal("-100")


def compute_sku_action_reward(
    action_kind: str,
    pre_unit_econ_cents: int,
    post_unit_econ_cents: int,
    units: int,
    undone: bool,
) -> Decimal:
    if undone:
        return UNDO_PENALTY
    if action_kind == "discontinue_sku":
        # Loss averted: credit the per-unit bleed we stopped (only if it WAS
        # bleeding). post is 0 (product retired, no more units). A profitable SKU
        # killed -> negative (we destroyed margin).
        if pre_unit_econ_cents < 0:
            return Decimal(-pre_unit_econ_cents) * units / 100
        return Decimal(-pre_unit_econ_cents) * units / 100  # negative: profit lost
    if action_kind == "adjust_price":
        # Profit delta per unit * units sold in the post window.
        return Decimal(post_unit_econ_cents - pre_unit_econ_cents) * units / 100
    return Decimal("0")


def compute_inventory_reward(
    units_sold_dest_post: int,
    unit_margin_cents: int,
    source_stockout_units: int,
    undone: bool,
) -> Decimal:
    if undone:
        return UNDO_PENALTY
    # Margin captured by selling relocated stock at the destination, net of any
    # sales lost because the source ran short after the move.
    gained = Decimal(units_sold_dest_post) * unit_margin_cents / 100
    lost = Decimal(source_stockout_units) * unit_margin_cents / 100
    return gained - lost
```

- [ ] **Step 4: Run to verify the kernel passes**

Run: `pytest tests/engine/moat/test_sku_action_rewards.py -v`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the SKU input-derivation test + implementation**

Write `tests/engine/moat/test_sku_reward_inputs.py` with a `_FakeConn` (same pattern
as Task 3) returning canned `action_audit` SKU rows + `order_line_fact` aggregates,
asserting one `ActionRewardInput` per closed-window SKU action with the right reward
sign. Then implement `derive_sku_action_reward_inputs` in `sku_reward_inputs.py`:

```python
"""Derive reward inputs for SKU/variant/location-scoped autopilot actions
(discontinue_sku, adjust_price, reallocate_inventory). Mirrors
action_reward_inputs.py but reads SKU economics instead of campaign ROAS.
Own raw data only (invariant A5). pgbouncer-safe plain fetches.
"""
from __future__ import annotations
from datetime import date, datetime, timedelta
from decimal import Decimal

from calderyn_engine.moat.action_reward_inputs import ActionRewardInput, WINDOW_DAYS
from calderyn_engine.moat.action_reward_windows import confirmation_window_days
from calderyn_engine.moat.sku_action_rewards import (
    compute_sku_action_reward, compute_inventory_reward,
)

# SKU autopilot actions: sku_id from params, detector from the joined alert.
_SKU_ACTIONS_SQL = """
SELECT a.id, a.action_kind, a.created_at,
       (a.params->>'sku_id')         AS sku_id,
       (a.params->>'to_location_id') AS to_location_id,
       (a.params->>'delta')::int     AS delta,
       COALESCE(al.detector_id, 'unknown') AS detector_id,
       EXISTS (SELECT 1 FROM public.action_audit u WHERE u.undo_of = a.id) AS undone
  FROM public.action_audit a
  LEFT JOIN public.alerts al ON al.id = a.alert_id
 WHERE a.shop_id = $1 AND a.actor_user_id = 'autopilot' AND a.outcome = 'succeeded'
   AND a.action_kind IN ('discontinue_sku','adjust_price','reallocate_inventory')
"""

# Per-SKU unit economics + units over a window (mirrors negative_unit_economics).
_SKU_ECON_SQL = """
SELECT ol.sku_id,
       SUM(ol.quantity)                                                   AS units,
       (SUM(ol.price_cents * ol.quantity)
        - SUM(COALESCE(ol.unit_cost_cents_snapshot,0) * ol.quantity))::numeric
        / NULLIF(SUM(ol.quantity),0)                                      AS unit_margin_cents
  FROM public.order_line_fact ol
  JOIN public.order_fact o ON o.id = ol.order_id AND o.shop_id = ol.shop_id
 WHERE ol.shop_id = $1 AND ol.sku_id = $2
   AND o.created_at_source >= $3 AND o.created_at_source < $4
 GROUP BY ol.sku_id
"""


async def derive_sku_action_reward_inputs(conn, shop_id, run_date: date):
    rows = await conn.fetch(_SKU_ACTIONS_SQL, shop_id)
    out: list[ActionRewardInput] = []
    for a in rows:
        created = a["created_at"]
        if not isinstance(created, datetime):
            created = datetime.fromisoformat(str(created))
        ad = created.date()
        win = confirmation_window_days(a["action_kind"])
        lo = ad - timedelta(days=WINDOW_DAYS)
        hi = ad + timedelta(days=win)
        window_closed = run_date >= hi

        if a["action_kind"] == "reallocate_inventory":
            post = await conn.fetch(_SKU_ECON_SQL, shop_id, a["sku_id"], ad, hi)
            units = int(post[0]["units"]) if post else 0
            margin = int(post[0]["unit_margin_cents"]) if post else 0
            reward = compute_inventory_reward(units, margin, 0, bool(a["undone"]))
            # v1: source_stockout_units=0 (a refinement once stockout attribution
            # at the source location is wired; documented, not silently dropped).
        else:
            pre = await conn.fetch(_SKU_ECON_SQL, shop_id, a["sku_id"], lo, ad)
            post = await conn.fetch(_SKU_ECON_SQL, shop_id, a["sku_id"], ad, hi)
            pre_econ = int(pre[0]["unit_margin_cents"]) if pre else 0
            post_econ = int(post[0]["unit_margin_cents"]) if post else 0
            units = int(post[0]["units"]) if post else (int(pre[0]["units"]) if pre else 0)
            reward = compute_sku_action_reward(
                a["action_kind"], pre_econ, post_econ, units, bool(a["undone"]),
            )

        out.append(ActionRewardInput(
            shop_id=shop_id, detector_id=a["detector_id"], action_kind=a["action_kind"],
            campaign_id="", chosen_pct=0.0, reward=reward, action_id=a["id"],
            window_closed=window_closed, action_created_at=created,
        ))
    return out
```

- [ ] **Step 6: Persist SKU rewards too**

In `persist_action_rewards.py`, after the campaign loop, also iterate
`derive_sku_action_reward_inputs(conn, shop_id, run_date)` and write closed-window
rows the same way. (Both derivations return the same `ActionRewardInput` shape, so
the existing `_UPDATE_SQL` write is reused.)

- [ ] **Step 7: Run the engine suite**

Run: `pytest tests/engine/moat -q`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add engine/calderyn_engine/moat/sku_action_rewards.py engine/calderyn_engine/moat/sku_reward_inputs.py engine/calderyn_engine/moat/persist_action_rewards.py tests/engine/moat/test_sku_action_rewards.py tests/engine/moat/test_sku_reward_inputs.py
git commit -m "engine/moat: SKU-scoped reward path for discontinue/price/inventory actions"
```

---

### Task 17: Guardrails — bounded-magnitude caps for price + inventory

**Files:**
- Create: `supabase/migrations/20260626130000_autopilot_price_inventory_caps.sql` (+ engine mirror)
- Modify: `app/lib/actions/guardrails.ts`
- Test: `app/lib/actions/__tests__/guardrails-price-inventory.test.ts`

**Interfaces:**
- Consumes: `AutopilotGuardrails`, `GuardrailFacts`, `evaluateGuardrails` (existing).
- Produces: `AutopilotGuardrails` gains `maxPriceChangePct: number` and `maxInventoryUnitsPerMove: number | null`; `GuardrailFacts` gains `priceChangePct?: number` and `inventoryUnitsMoved?: number`; `evaluateGuardrails` blocks `adjust_price` over the pct cap and `reallocate_inventory` over the unit cap.

- [ ] **Step 1: Write the migration**

```sql
-- Bounded-magnitude autonomy for high-stakes actions (design §2.4). Stored on the
-- same per-shop autopilot guardrail config as the budget caps. Defaults are
-- conservative: 10% max autonomous price move, 50 units max autonomous stock move.
alter table public.autopilot_guardrails
  add column if not exists max_price_change_pct numeric not null default 10,
  add column if not exists max_inventory_units_per_move integer;
```

> The exact guardrail table/column naming must match the existing autopilot
> guardrail storage — open `supabase/migrations/20260606140000_autopilot_guardrails.sql`
> and mirror its table name + style. Add the engine-mirror copy under
> `tests/engine/schema/migrations/`.

- [ ] **Step 2: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { evaluateGuardrails, type AutopilotGuardrails, type GuardrailFacts } from "../guardrails";

const cfg: AutopilotGuardrails = {
  enabled: true, bypassGuardrails: false, dailyActionCap: 10, minSpendCents: 0,
  maxBudgetCutPct: 50, maxBudgetIncreasePct: 50, maxDailyBudgetCents: null,
  dollarCapCents: 100000, cooldownMinutes: 0, businessHoursOnly: false,
  businessHoursStartUtc: 0, businessHoursEndUtc: 0,
  maxPriceChangePct: 10, maxInventoryUnitsPerMove: 50,
};
const facts = (over: Partial<GuardrailFacts>): GuardrailFacts => ({
  kind: "adjust_price", dollarImpactCents: 0, campaignSpendCents: 0,
  todayAutopilotCount: 0, minutesSinceLastActionOnCampaign: null, nowUtcHour: 12, ...over,
});

describe("price/inventory caps", () => {
  it("blocks a price move beyond the cap", () => {
    const r = evaluateGuardrails(cfg, facts({ kind: "adjust_price", priceChangePct: 25 }));
    expect(r).toEqual({ allowed: false, reason: "price change exceeds max" });
  });
  it("allows a price move at the cap", () => {
    expect(evaluateGuardrails(cfg, facts({ kind: "adjust_price", priceChangePct: 10 })).allowed).toBe(true);
  });
  it("blocks an inventory move beyond the unit cap", () => {
    const r = evaluateGuardrails(cfg, facts({ kind: "reallocate_inventory", inventoryUnitsMoved: 80 }));
    expect(r).toEqual({ allowed: false, reason: "inventory move exceeds max units" });
  });
});
```

- [ ] **Step 3: Edit `guardrails.ts`**

Add the two config fields + two fact fields to the interfaces (mirroring the JSDoc
style), then add the checks in `evaluateGuardrails`, before the business-hours check:

```ts
  if (
    facts.kind === "adjust_price" &&
    facts.priceChangePct != null &&
    Math.abs(facts.priceChangePct) > cfg.maxPriceChangePct + 1e-9
  ) {
    return { allowed: false, reason: "price change exceeds max" };
  }
  if (
    facts.kind === "reallocate_inventory" &&
    cfg.maxInventoryUnitsPerMove != null &&
    facts.inventoryUnitsMoved != null &&
    facts.inventoryUnitsMoved > cfg.maxInventoryUnitsPerMove
  ) {
    return { allowed: false, reason: "inventory move exceeds max units" };
  }
```

Note `GuardedKind` already resolves from `ExecutableKind`; confirm `adjust_price`
and `reallocate_inventory` are in `ExecutableKind` (they have executors per
`HAS_EXECUTOR`); if not, extend `GuardedKind` accordingly.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run app/lib/actions/__tests__/guardrails-price-inventory.test.ts app/lib/actions/__tests__/guardrails.test.ts`
Expected: PASS (existing guardrail tests still green).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260626130000_autopilot_price_inventory_caps.sql tests/engine/schema/migrations/20260626130000_autopilot_price_inventory_caps.sql app/lib/actions/guardrails.ts app/lib/actions/__tests__/guardrails-price-inventory.test.ts
git commit -m "actions: bounded-magnitude guardrails for adjust_price + reallocate_inventory"
```

---

### Task 18: Supply price/inventory facts on the autonomous path

**Files:**
- Modify: `app/lib/actions/guardrails.server.ts` (build the new facts)
- Modify: `app/lib/actions/autopilot.server.ts` (pass them on the autonomous branch)
- Test: `app/lib/actions/__tests__/guardrails-server.test.ts` (extend)

**Interfaces:**
- Consumes: Task 17's `GuardrailFacts` additions + the new config columns.
- Produces: the autonomous price/inventory path computes `priceChangePct` (from prior vs new price) and `inventoryUnitsMoved` (the transfer delta) and includes them in the `GuardrailFacts` passed to `evaluateGuardrails`, so an over-cap autonomous move is blocked and falls back to the Action Queue.

- [ ] **Step 1: Write the failing test**

Extend `guardrails-server.test.ts`: given an `adjust_price` autonomous action whose
new price is 25% above the prior, assert the server fact-builder sets
`priceChangePct ≈ 25` and the call is blocked. (Reuse the file's existing
fact-builder harness.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/lib/actions/__tests__/guardrails-server.test.ts`
Expected: FAIL (facts not yet populated).

- [ ] **Step 3: Edit the server fact-builder + autopilot call site**

In `guardrails.server.ts`, where `GuardrailFacts` is assembled, add:

```ts
    priceChangePct:
      kind === "adjust_price" && priorPriceCents > 0
        ? ((newPriceCents - priorPriceCents) / priorPriceCents) * 100
        : undefined,
    inventoryUnitsMoved: kind === "reallocate_inventory" ? Math.abs(deltaUnits) : undefined,
```

In `autopilot.server.ts`, on the autonomous execution branch for these kinds
(after `isGraduated` passes), ensure the prior price / delta are threaded into the
guardrail facts before `evaluateGuardrails`. A blocked result must route the action
to the Action Queue (propose) rather than execute — mirror how an over-budget-cut
campaign action is currently demoted to a proposal.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run app/lib/actions/__tests__/guardrails-server.test.ts app/routes/__tests__/cron.autopilot.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/actions/guardrails.server.ts app/lib/actions/autopilot.server.ts app/lib/actions/__tests__/guardrails-server.test.ts
git commit -m "autopilot: enforce price/inventory caps on the autonomous path (over-cap -> queue)"
```

---

### Task 19: Flip the four into `GRADUATABLE`

**Files:**
- Modify: `app/lib/calibration/graduation.ts` (rename `GRADUATABLE_V1` → `GRADUATABLE`, add 4 kinds)
- Modify: every importer of `GRADUATABLE_V1` (`graduation.server.ts`)
- Test: `app/lib/calibration/__tests__/graduation-set.test.ts`

**Interfaces:**
- Produces: `GRADUATABLE = { pause_campaign, reduce_campaign_budget, discontinue_sku, resume_campaign, reallocate_budget, reallocate_inventory, adjust_price }`. Keep a `export const GRADUATABLE_V1 = GRADUATABLE` alias for one release to avoid a big-bang import churn, or update all importers in this task (preferred — grep first).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { GRADUATABLE } from "../graduation";

it("contains exactly the seven graduatable kinds", () => {
  expect([...GRADUATABLE].sort()).toEqual([
    "adjust_price", "discontinue_sku", "pause_campaign", "reallocate_budget",
    "reallocate_inventory", "reduce_campaign_budget", "resume_campaign",
  ]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/lib/calibration/__tests__/graduation-set.test.ts`
Expected: FAIL.

- [ ] **Step 3: Edit `graduation.ts`**

```ts
export const GRADUATABLE: ReadonlySet<ActionKind> = new Set<ActionKind>([
  "pause_campaign",
  "reduce_campaign_budget",
  "discontinue_sku",
  "resume_campaign",
  "reallocate_budget",
  "reallocate_inventory",
  "adjust_price",
]);
```

Update `graduationVerdict`'s gate 1 to use `GRADUATABLE`. Run
`grep -rn "GRADUATABLE_V1" app/` and update each importer (e.g.
`graduation.server.ts::countNearGraduation`).

- [ ] **Step 4: Run typecheck + full calibration/action suites**

Run: `npm run typecheck && npx vitest run app/lib/calibration app/lib/actions`
Expected: exit 0; all PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/calibration/graduation.ts app/lib/calibration/graduation.server.ts app/lib/calibration/__tests__/graduation-set.test.ts
git commit -m "calibration: expand graduatable set to 7 (resume, reallocate budget+inventory, price)"
```

---

### Task 20: UI — new actions in the track + cap settings (both surfaces)

**Files:**
- Modify: dashboard settings (`app/components/dashboard/screens/Settings.tsx` + `app/routes/dashboard.api.guardrails.tsx` + `app/lib/dashboard/guardrails-validation.ts`)
- Modify: embedded settings (`app/routes/app.settings.tsx`)
- Modify: any place that enumerates graduatable actions for display (driven by `GRADUATABLE` + `DETECTOR_TO_ACTIONS`, so the four appear automatically once Task 19 lands — verify)
- Test: `app/lib/dashboard/__tests__/guardrails-validation.test.ts` (extend)

**Interfaces:**
- Consumes: Task 17's config fields.
- Produces: merchant can set `maxPriceChangePct` and `maxInventoryUnitsPerMove` from BOTH surfaces; both validate (price 0–100, units ≥ 1 or blank=unlimited); the four new actions render in the calibration track / Live Engine with their two-bar progress (Task 11 already generic over `GRADUATABLE`).

- [ ] **Step 1: Extend guardrail validation (failing test)**

```ts
it("accepts a valid price cap and rejects out-of-range", () => {
  expect(validateGuardrails({ maxPriceChangePct: 10 }).ok).toBe(true);
  expect(validateGuardrails({ maxPriceChangePct: 150 }).ok).toBe(false);
});
it("accepts a blank inventory cap as unlimited", () => {
  expect(validateGuardrails({ maxInventoryUnitsPerMove: null }).ok).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/lib/dashboard/__tests__/guardrails-validation.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement validation + wire the fields**

Add the two fields to `guardrails-validation.ts` (clamp/validate), to the dashboard
guardrails API write route and its Settings form, and to the embedded
`app.settings.tsx` guardrails form. Use surface-native primitives (Polaris fields in
embedded; the dashboard's own inputs in dashboard). Plain labels: "Most a price can
move on its own (%)", "Most stock Calderyn can move on its own (units)".

- [ ] **Step 4: Run to verify + typecheck**

Run: `npm run typecheck && npx vitest run app/lib/dashboard app/routes/__tests__/app.settings.guardrails.test.ts`
Expected: exit 0; all PASS.

- [ ] **Step 5: Commit**

```bash
git add app/components/dashboard/screens/Settings.tsx app/routes/dashboard.api.guardrails.tsx app/lib/dashboard/guardrails-validation.ts app/routes/app.settings.tsx app/lib/dashboard/__tests__/guardrails-validation.test.ts
git commit -m "settings: price/inventory autonomy caps on both surfaces; new actions in track"
```

---

### Task 21: Phase 2 verification gate

**Files:** none (verification only).

- [ ] **Step 1: Full eval pipeline** — `npm run typecheck`, `npm run lint`, `npm run build` (all exit 0); `npx vitest run` (TS) and `pytest tests/engine` (Python) all green. Paste output.
- [ ] **Step 2: `/code-review`** the full Phase 2 diff; resolve blockers.
- [ ] **Step 3: Migration check** — `npx prisma migrate diff --exit-code` N/A (no Prisma); instead confirm every new `supabase/migrations/*.sql` has an identical `tests/engine/schema/migrations/*.sql` mirror, and the engine schema bootstrap test passes.
- [ ] **Step 4: Behavioral check (review store)** — seed a `reallocate_inventory` and an `adjust_price` autopilot action, confirm: over-cap moves route to the queue; under-cap moves execute; closed-window positive rewards advance the outcome bar; the four new actions show two-bar progress on both surfaces.
- [ ] **Step 5: Dashboard parity sign-off** — confirm both surfaces show the new actions + caps; note explicitly in the PR description that parity is satisfied.

---

## Self-Review

(Completed by the plan author; see the conversation. Spec coverage: §1 problem → Tasks 5–10; §2.1 two-bar → Tasks 5,6,8,9,11; §2.2 expansion → Tasks 13,14,15,16,19; §2.3 demotion → Tasks 6,8,10; §2.4 bounded magnitude → Tasks 17,18,20; §4.2 windows → Tasks 2,3; §5 parity → Tasks 11,20; §5b reality/phasing → phase split. Open risk: Task 16's SKU/inventory metrics depend on data confirmed in its Step 0 spike.)

