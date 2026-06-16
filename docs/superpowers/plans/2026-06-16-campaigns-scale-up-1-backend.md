# Campaigns Scale-Up — Plan 1: Backend (engine + action + guardrail + autopilot) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect winning ad campaigns and let autopilot raise their daily budgets within guardrails — the offensive half of the action loop (today autopilot only cuts/pauses/reallocates).

**Architecture:** A new Python detector `campaign_scaling_opportunity` reads persisted campaign grades, emits an alert per winner with a projected-margin `dollar_impact`. The alert flows through the existing `v_autopilot_candidates` view into the existing autopilot loop, which maps it to a new `increase_campaign_budget` executable. That executable reuses the existing `executeAction` orchestrator (idempotency + ownership + audit + undo) and the existing per-platform `setDailyBudget` adapters (Meta/Google/TikTok). A new guardrail caps the increase % and an optional daily ceiling.

**Tech Stack:** Python 3 (`engine/calderyn_engine`, asyncpg, pydantic, pytest/uv), TypeScript (Remix app, Vitest), Supabase Postgres (SQL migrations, `security_invoker` views).

**Spec:** `docs/superpowers/specs/2026-06-16-campaigns-scale-up-design.md`

**Key facts that constrain this plan (verified in code):**
- `alerts.dollar_impact` is in **dollars** (comment at `app/lib/actions/execute.server.ts:68-69`). The estimator returns dollars; autopilot converts to cents at the guardrail boundary (`autopilot.server.ts:155`).
- `v_autopilot_candidates` filters by a hard-coded `detector_id IN (...)` list (`supabase/migrations/20260606150000_autopilot_candidates_view.sql`). The new detector MUST be added there or autopilot never sees it.
- The `setDailyBudget(externalId, cents)` adapter already exists for all three platforms and is what `reduce_campaign_budget` calls — `increase_campaign_budget` needs **no** new adapter code.
- `pipeline.py` runs detectors (line 161) **before** grading (line 172), so the detector reads the prior run's grades. Detectors are force-imported at `pipeline.py:56`.
- `ActionKind` (`app/lib/types.ts:5`) and `DetectorId` (`:16`) are unions consumed by `Record<...>` maps in `labels.ts`; adding a union member makes `tsc` require the new key everywhere — that is the desired forcing function.

---

## File Structure

**Create:**
- `engine/calderyn_engine/estimators/scale_upside.py` — pure estimator: projected incremental margin from a budget step.
- `engine/calderyn_engine/detectors/campaign_scaling_opportunity.py` — detector: emit one alert per winning campaign.
- `tests/engine/unit/test_estimator_scale_upside.py` — estimator unit tests (DB-free).
- `tests/engine/unit/test_detector_campaign_scaling_opportunity.py` — detector tests (DB-gated).
- `supabase/migrations/20260616130000_autopilot_scale_guardrails.sql` — add 2 guardrail_config columns.
- `supabase/migrations/20260616130100_autopilot_candidates_add_scale.sql` — add detector to the candidates view.

**Modify:**
- `tests/engine/schema/` vendored copy — mirror both migrations so DB-gated tests see the new columns/view.
- `engine/calderyn_engine/pipeline.py:56-69` — import the new detector module.
- `app/lib/types.ts:5-15,16-29` — add `increase_campaign_budget` to `ActionKind`, `campaign_scaling_opportunity` to `DetectorId`.
- `app/lib/labels.ts` — add entries to `ACTION_LABELS`, `ACTION_VERBS`, `DETECTOR_LABELS`, `DETECTOR_TERMS`, `DETECTOR_TO_ACTIONS`.
- `app/lib/actions/execute.server.ts:14,180-209` — add `increase_campaign_budget` to `ExecutableKind`, its validation, its post-state.
- the recovered-dollars helper(s) referenced at `execute.server.ts:68-95` — treat an increase as recovering $0.
- `app/lib/actions/guardrails.ts:10-20,47-75` — add `maxBudgetIncreasePct`/`maxDailyBudgetCents` to `AutopilotGuardrails`; add the increase check.
- `app/lib/actions/guardrails.server.ts:59-72` — select + map the two new columns.
- `app/lib/actions/autopilot.server.ts` — `SCALE_DETECTORS`, defensive-first ordering, increase target math, facts, execute.

---

## Task 1: Migration — guardrail_config increase caps

**Files:**
- Create: `supabase/migrations/20260616130000_autopilot_scale_guardrails.sql`
- Modify (mirror): the vendored test schema under `tests/engine/schema/migrations/` (add an identically-named copy so DB-gated tests see the columns)

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260616130000_autopilot_scale_guardrails.sql`:

```sql
-- F1 scale-up: per-shop caps for autopilot budget INCREASES (mirror of the
-- existing autopilot_max_budget_cut_pct). max_daily_budget_cents is nullable:
-- NULL means "no ceiling" so existing shops are not unexpectedly blocked.
alter table public.guardrail_config
  add column if not exists autopilot_max_budget_increase_pct int not null default 20,
  add column if not exists autopilot_max_daily_budget_cents   int;
```

- [ ] **Step 2: Mirror into the vendored test schema**

Find the test-schema migrations directory (the existing autopilot columns live in `tests/engine/schema/migrations/20260606140000_autopilot_guardrails.sql`). Create `tests/engine/schema/migrations/20260616130000_autopilot_scale_guardrails.sql` with the **same** SQL as Step 1. Run to confirm the directory and naming convention:

Run: `ls tests/engine/schema/migrations/ | grep autopilot`
Expected: lists `20260606140000_autopilot_guardrails.sql` (confirms location + naming).

- [ ] **Step 3: Verify the SQL parses against a scratch DB**

If a local test DB is available, apply the migration to confirm it's valid:

Run: `tests/engine/scripts/test-db.sh up && psql "$TEST_DATABASE_URL" -f supabase/migrations/20260616130000_autopilot_scale_guardrails.sql`
Expected: `ALTER TABLE` with no error. (If no local DB, defer to the detector-test run in Task 4, which exercises the column.)

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260616130000_autopilot_scale_guardrails.sql tests/engine/schema/migrations/20260616130000_autopilot_scale_guardrails.sql
git commit -m "migrations: guardrail_config autopilot budget-increase caps"
```

> The prod Supabase apply happens via the Supabase MCP/CLI at execution time (this repo applies SQL migrations to live Supabase — there is no Prisma schema change here, so the Prisma gate step does not apply).

---

## Task 2: Migration — add scale detector to v_autopilot_candidates

**Files:**
- Create: `supabase/migrations/20260616130100_autopilot_candidates_add_scale.sql`
- Modify (mirror): `tests/engine/schema/migrations/20260616130100_autopilot_candidates_add_scale.sql`

- [ ] **Step 1: Write the migration (re-create the view with the new detector id)**

Create `supabase/migrations/20260616130100_autopilot_candidates_add_scale.sql`. This is the existing view body (from `20260606150000_autopilot_candidates_view.sql`) with `campaign_scaling_opportunity` added to the `IN (...)` list:

```sql
-- F1 scale-up: surface campaign_scaling_opportunity alerts to autopilot. Same
-- body as 20260606150000; only the detector_id allow-list gains the new id.
-- security_invoker so per-shop RLS still applies.
create or replace view public.v_autopilot_candidates
with (security_invoker = true) as
select
  a.id            as alert_id,
  a.shop_id       as shop_id,
  a.detector_id   as detector_id,
  a.dollar_impact as dollar_impact,
  c.id            as campaign_id,
  coalesce(c.daily_budget_cents, 0) as daily_budget_cents,
  coalesce((
    select sum(s.spend_cents) from public.ad_spend_fact s
    where s.campaign_id = c.id and s.day >= (current_date - 7)
  ), 0) as campaign_spend_cents
from public.alerts a
join public.ad_campaign_dim c on c.id = (a.entity_ref->>'campaign_id')::uuid
where a.status = 'open'
  and a.detector_id in (
    'campaign_below_breakeven',
    'negative_unit_economics',
    'ad_tax_overload',
    'campaign_scaling_opportunity'
  );
```

- [ ] **Step 2: Mirror into the vendored test schema**

Create `tests/engine/schema/migrations/20260616130100_autopilot_candidates_add_scale.sql` with the same SQL.

- [ ] **Step 3: Verify SQL parses**

Run (if local DB available): `psql "$TEST_DATABASE_URL" -f supabase/migrations/20260616130100_autopilot_candidates_add_scale.sql`
Expected: `CREATE VIEW` with no error.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260616130100_autopilot_candidates_add_scale.sql tests/engine/schema/migrations/20260616130100_autopilot_candidates_add_scale.sql
git commit -m "migrations: v_autopilot_candidates includes campaign_scaling_opportunity"
```

---

## Task 3: Estimator — scale_upside.py (TDD)

**Files:**
- Test: `tests/engine/unit/test_estimator_scale_upside.py`
- Create: `engine/calderyn_engine/estimators/scale_upside.py`

The estimator answers: "if we add `increase_pct`% to a winner's daily budget and ROAS holds, how many dollars of incremental contribution margin over `horizon_days`?" For a winner, net margin per added dollar = `roas*margin - 1` (≥ 0.2, since `winning ⇒ roas ≥ 1.2/margin`). Returns dollars (matching `alerts.dollar_impact`).

- [ ] **Step 1: Write the failing test**

Create `tests/engine/unit/test_estimator_scale_upside.py`:

```python
"""Unit tests for ``estimate_scale_upside``.

Projected incremental contribution margin from raising a winning campaign's
daily budget, assuming ROAS holds at its current level over the horizon.
Returns DOLLARS (matching alerts.dollar_impact), rounded to cents.
"""

from decimal import Decimal

from calderyn_engine.estimators.scale_upside import estimate_scale_upside


def test_standard_winner_upside() -> None:
    # current $100/day, +20% => +$20/day incremental spend.
    # roas 3.0, margin 0.5 => net per $1 = 3.0*0.5 - 1 = 0.5.
    # 20/day * 0.5 * 30 days = $300.00.
    out = estimate_scale_upside(
        current_daily_cents=10_000,
        roas=Decimal("3.0"),
        margin=Decimal("0.5"),
        increase_pct=20,
        horizon_days=30,
    )
    assert out == Decimal("300.00")


def test_marginal_winner_floor() -> None:
    # roas 2.4, margin 0.5 => net per $1 = 0.2 (the winning floor: 1.2/margin).
    # current $50/day, +20% => $10/day. 10 * 0.2 * 30 = $60.00.
    out = estimate_scale_upside(
        current_daily_cents=5_000,
        roas=Decimal("2.4"),
        margin=Decimal("0.5"),
        increase_pct=20,
        horizon_days=30,
    )
    assert out == Decimal("60.00")


def test_never_negative() -> None:
    # A non-winner (net per $1 negative) must not produce a negative upside —
    # the detector only feeds winners, but the estimator clips defensively.
    out = estimate_scale_upside(
        current_daily_cents=10_000,
        roas=Decimal("1.0"),
        margin=Decimal("0.5"),
        increase_pct=20,
        horizon_days=30,
    )
    assert out == Decimal("0.00")


def test_zero_budget_is_zero() -> None:
    out = estimate_scale_upside(
        current_daily_cents=0,
        roas=Decimal("3.0"),
        margin=Decimal("0.5"),
        increase_pct=20,
        horizon_days=30,
    )
    assert out == Decimal("0.00")


def test_rounds_half_up_to_cents() -> None:
    # 10000c=$100, +1% => $1/day; roas 2.5 margin 0.5 => net 0.25.
    # 1 * 0.25 * 30 = 7.50 exactly; nudge with a fractional pct to test rounding.
    out = estimate_scale_upside(
        current_daily_cents=10_000,
        roas=Decimal("2.5"),
        margin=Decimal("0.5"),
        increase_pct=1,
        horizon_days=30,
    )
    assert out == Decimal("7.50")
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd engine && uv run pytest ../tests/engine/unit/test_estimator_scale_upside.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'calderyn_engine.estimators.scale_upside'`.

- [ ] **Step 3: Implement the estimator**

Create `engine/calderyn_engine/estimators/scale_upside.py`:

```python
"""Estimator: projected incremental contribution margin from scaling a winner.

We raise a winning campaign's daily budget by ``increase_pct`` percent and
assume its ROAS holds at the current level over ``horizon_days``. Per added
dollar of spend the incremental contribution margin is ``roas * margin - 1``
(revenue per dollar * margin, minus the dollar spent). For a *winning*
campaign this is >= 0.2 because winning means ``roas >= 1.2 / margin``.

This is an optimistic "if performance holds" projection (real scaling sees
diminishing returns); it exists to rank and explain opportunities, not to
promise an outcome. Returns DOLLARS, matching ``alerts.dollar_impact``.
"""

from decimal import ROUND_HALF_UP, Decimal

CENTS = Decimal("0.01")
ZERO = Decimal("0")
ONE = Decimal("1")
HUNDRED = Decimal("100")


def estimate_scale_upside(
    current_daily_cents: int,
    roas: Decimal,
    margin: Decimal,
    increase_pct: int,
    horizon_days: int = 30,
) -> Decimal:
    """Return projected incremental margin (dollars) over the horizon.

    Parameters
    ----------
    current_daily_cents:
        The campaign's current daily budget, in cents.
    roas:
        Current return on ad spend (revenue / spend).
    margin:
        Contribution margin (0 < margin < 1) used to grade the campaign.
    increase_pct:
        Percentage to raise the daily budget by (e.g. 20).
    horizon_days:
        Projection window. Defaults to 30 to match the "+$X/mo" framing.

    Returns
    -------
    Decimal
        ``max(incremental_daily_dollars * (roas*margin - 1) * horizon, 0)``,
        rounded half-up to cents.
    """
    incremental_daily_dollars = (
        Decimal(current_daily_cents) / HUNDRED
    ) * (Decimal(increase_pct) / HUNDRED)
    net_per_dollar = roas * margin - ONE
    upside = incremental_daily_dollars * net_per_dollar * Decimal(horizon_days)
    return max(upside, ZERO).quantize(CENTS, rounding=ROUND_HALF_UP)
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd engine && uv run pytest ../tests/engine/unit/test_estimator_scale_upside.py -v`
Expected: PASS (5 passed).

- [ ] **Step 5: Commit**

```bash
git add engine/calderyn_engine/estimators/scale_upside.py tests/engine/unit/test_estimator_scale_upside.py
git commit -m "engine/estimators: scale_upside projected incremental margin"
```

---

## Task 4: Detector — campaign_scaling_opportunity.py (TDD)

**Files:**
- Test: `tests/engine/unit/test_detector_campaign_scaling_opportunity.py`
- Create: `engine/calderyn_engine/detectors/campaign_scaling_opportunity.py`

The detector reads the latest persisted grade per active campaign (`campaign_grade_fact`, joined to `ad_campaign_dim` for current budget/platform/status), keeps `grade = 'winning'` campaigns with a positive current budget, reads the shop's `autopilot_max_budget_increase_pct` from `guardrail_config` (default 20), computes `dollar_impact` via `estimate_scale_upside`, and emits one `DetectionResult` each. It mirrors `campaign_below_breakeven.py`'s structure exactly.

> **Threshold:** emit only when projected upside ≥ `DEFAULT_THRESHOLD_USD` ($25), so we never surface trivial scale nudges. Documented + tested.
> **Staleness:** grades come from the prior pipeline run (pipeline grades after detecting). Acceptable — grades move slowly; on a shop's first run there are no grades and the detector emits nothing.

- [ ] **Step 1: Write the failing test**

Create `tests/engine/unit/test_detector_campaign_scaling_opportunity.py`:

```python
"""Detector ``campaign_scaling_opportunity``: winning campaigns worth scaling.

DB-gated (needs TEST_DATABASE_URL); skipped otherwise via the pg_pool fixture.
Mirrors test_detector_campaign_below_breakeven.py's harness.
"""

from __future__ import annotations

from datetime import datetime, UTC
from decimal import Decimal

import pytest

from calderyn_engine.db import with_shop_context
from calderyn_engine.detectors.campaign_scaling_opportunity import (
    DEFAULT_THRESHOLD_USD,
    detect,
)

SHOP = "00000000-0000-0000-0000-0000000000c1"
NOW = datetime(2026, 6, 16, tzinfo=UTC)


def test_threshold_constant_is_25_usd() -> None:
    assert DEFAULT_THRESHOLD_USD == Decimal("25")


@pytest.mark.asyncio
async def test_fires_for_a_winning_campaign(
    pg_pool, seed_shop, seed_scale_scenario
) -> None:
    await seed_shop(SHOP)
    # grade 'winning', roas 3.0, margin 0.5, budget $100/day; default +20%, 30d
    # => upside 20 * 0.5 * 30 = $300 >= $25 threshold.
    await seed_scale_scenario(
        SHOP,
        grade="winning",
        roas=Decimal("3.0"),
        margin=Decimal("0.5"),
        daily_budget_cents=10_000,
    )
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            results = await detect(SHOP, conn, NOW)
    assert len(results) == 1
    r = results[0]
    assert r.detector_id == "campaign_scaling_opportunity"
    assert r.entity_ref["campaign_id"]
    assert r.dollar_impact == Decimal("300.00")


@pytest.mark.asyncio
async def test_does_not_fire_for_non_winning(
    pg_pool, seed_shop, seed_scale_scenario
) -> None:
    await seed_shop(SHOP)
    await seed_scale_scenario(
        SHOP,
        grade="okay",
        roas=Decimal("2.0"),
        margin=Decimal("0.5"),
        daily_budget_cents=10_000,
    )
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            results = await detect(SHOP, conn, NOW)
    assert results == []


@pytest.mark.asyncio
async def test_does_not_fire_below_threshold(
    pg_pool, seed_shop, seed_scale_scenario
) -> None:
    await seed_shop(SHOP)
    # tiny budget => upside below $25: $5/day budget, +20% = $1/day,
    # net 0.5 => 1 * 0.5 * 30 = $15 < $25.
    await seed_scale_scenario(
        SHOP,
        grade="winning",
        roas=Decimal("3.0"),
        margin=Decimal("0.5"),
        daily_budget_cents=500,
    )
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            results = await detect(SHOP, conn, NOW)
    assert results == []


@pytest.mark.asyncio
async def test_does_not_fire_with_no_budget(
    pg_pool, seed_shop, seed_scale_scenario
) -> None:
    await seed_shop(SHOP)
    await seed_scale_scenario(
        SHOP,
        grade="winning",
        roas=Decimal("3.0"),
        margin=Decimal("0.5"),
        daily_budget_cents=0,
    )
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            results = await detect(SHOP, conn, NOW)
    assert results == []
```

- [ ] **Step 2: Add the `seed_scale_scenario` fixture**

Open `tests/engine/conftest.py`, find `seed_breakeven_scenario` (used by `test_detector_campaign_below_breakeven.py`), and add a sibling fixture next to it. It must insert: a `ad_campaign_dim` row (active, with `daily_budget_cents`, platform 'meta'), and a `campaign_grade_fact` row (the given `grade`, `roas`, `margin`, a recent `day_bucket`), plus a `guardrail_config` row for the shop with `autopilot_max_budget_increase_pct = 20`. Mirror the column names from `campaign_grade_repo.py`'s `_UPSERT_SQL` and the `ad_domain` migration.

```python
@pytest.fixture
def seed_scale_scenario(pg_pool):
    """Seed one active campaign + its latest grade + a guardrail_config row.

    Mirrors seed_breakeven_scenario but writes a campaign_grade_fact row so the
    scaling detector (which reads grades, not raw spend) has input.
    """
    async def _seed(
        shop_id: str,
        *,
        grade: str,
        roas,
        margin,
        daily_budget_cents: int,
    ) -> str:
        campaign_id = "00000000-0000-0000-0000-0000000000ca"
        async with pg_pool.acquire() as conn:
            async with with_shop_context(conn, shop_id):
                await conn.execute(
                    """
                    insert into public.ad_campaign_dim
                      (id, shop_id, platform, external_id, name, status, daily_budget_cents, currency)
                    values ($1::uuid, $2::uuid, 'meta', 'ext-ca', 'Winner', 'active', $3, 'USD')
                    on conflict (id) do update set
                      status = 'active', daily_budget_cents = excluded.daily_budget_cents
                    """,
                    campaign_id, shop_id, daily_budget_cents,
                )
                await conn.execute(
                    """
                    insert into public.campaign_grade_fact
                      (shop_id, campaign_id, day_bucket, window_days, grade,
                       roas, break_even_roas, margin, confidence,
                       spend_cents, revenue_cents, cogs_cents, computed_at)
                    values ($1::uuid, $2::uuid, current_date, 7, $3,
                            $4, (1/$5), $5, 'ok', 100000, 300000, 150000, now())
                    on conflict (campaign_id, day_bucket) do update set
                      grade = excluded.grade, roas = excluded.roas, margin = excluded.margin
                    """,
                    shop_id, campaign_id, grade, roas, margin,
                )
                await conn.execute(
                    """
                    insert into public.guardrail_config (shop_id, autopilot_max_budget_increase_pct)
                    values ($1::uuid, 20)
                    on conflict (shop_id) do update set autopilot_max_budget_increase_pct = 20
                    """,
                    shop_id,
                )
        return campaign_id
    return _seed
```

- [ ] **Step 3: Run the test, verify it fails**

Run: `cd engine && uv run pytest ../tests/engine/unit/test_detector_campaign_scaling_opportunity.py::test_threshold_constant_is_25_usd -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'calderyn_engine.detectors.campaign_scaling_opportunity'`.

- [ ] **Step 4: Implement the detector**

Create `engine/calderyn_engine/detectors/campaign_scaling_opportunity.py`:

```python
"""Detector: winning ad campaigns whose daily budget is worth raising.

The offensive counterpart to campaign_below_breakeven. For each active
campaign we read its LATEST persisted grade (campaign_grade_fact, written by
campaign_grade_repo on the prior pipeline pass) joined to its current daily
budget. Winners (grade = 'winning', which already implies margin-positive:
winning means roas >= 1.2 / margin) with a positive budget produce one
DetectionResult whose dollar_impact is the projected incremental margin from
a +``increase_pct``% step, where increase_pct is the shop's configured
autopilot cap (default 20). Sub-$25 opportunities are dropped.

Grades are at most one pipeline cycle stale (pipeline grades AFTER detecting);
acceptable for a scale suggestion. On a shop's first run there are no grades
and this detector emits nothing.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal

import asyncpg

from calderyn_engine.detectors import register
from calderyn_engine.estimators.scale_upside import estimate_scale_upside
from calderyn_engine.schemas import DetectionResult

DETECTOR_ID = "campaign_scaling_opportunity"
DEFAULT_THRESHOLD_USD = Decimal("25")
DEFAULT_INCREASE_PCT = 20
HORIZON_DAYS = 30

# Latest grade per campaign (DISTINCT ON newest day_bucket) joined to the live
# campaign budget, plus the shop's configured increase cap. Active campaigns
# with a positive budget only.
_QUERY = """
WITH latest_grade AS (
    SELECT DISTINCT ON (g.campaign_id)
           g.campaign_id, g.grade, g.roas, g.margin
    FROM public.campaign_grade_fact g
    WHERE g.shop_id = $1
    ORDER BY g.campaign_id, g.day_bucket DESC
)
SELECT c.id          AS campaign_id,
       c.name        AS campaign_name,
       c.platform    AS platform,
       c.daily_budget_cents AS daily_budget_cents,
       lg.grade      AS grade,
       lg.roas       AS roas,
       lg.margin     AS margin,
       coalesce((
         SELECT gc.autopilot_max_budget_increase_pct
         FROM public.guardrail_config gc WHERE gc.shop_id = $1
       ), $2) AS increase_pct
FROM public.ad_campaign_dim c
JOIN latest_grade lg ON lg.campaign_id = c.id
WHERE c.shop_id = $1
  AND c.status = 'active'
  AND coalesce(c.daily_budget_cents, 0) > 0
  AND lg.grade = 'winning'
"""


@register(DETECTOR_ID)
async def detect(
    shop_id: str, conn: asyncpg.Connection, now: datetime
) -> list[DetectionResult]:
    """Run the detector and return zero-or-more DetectionResult rows."""
    rows = await conn.fetch(_QUERY, shop_id, DEFAULT_INCREASE_PCT)
    out: list[DetectionResult] = []
    for r in rows:
        budget_cents = int(r["daily_budget_cents"] or 0)
        roas = Decimal(r["roas"])
        margin = Decimal(r["margin"])
        increase_pct = int(r["increase_pct"] or DEFAULT_INCREASE_PCT)
        impact = estimate_scale_upside(
            current_daily_cents=budget_cents,
            roas=roas,
            margin=margin,
            increase_pct=increase_pct,
            horizon_days=HORIZON_DAYS,
        )
        if impact < DEFAULT_THRESHOLD_USD:
            continue
        out.append(
            DetectionResult(
                detector_id=DETECTOR_ID,
                entity_ref={
                    "campaign_id": str(r["campaign_id"]),
                    "platform": r["platform"],
                },
                severity="medium",
                dollar_impact=impact,
                evidence={
                    "campaign_name": r["campaign_name"],
                    "grade": r["grade"],
                    "roas": str(roas),
                    "margin": str(margin),
                    "daily_budget_usd": str(Decimal(budget_cents) / Decimal("100")),
                    "increase_pct": str(increase_pct),
                    "horizon_days": str(HORIZON_DAYS),
                },
            )
        )
    return out
```

- [ ] **Step 5: Run the detector tests, verify they pass**

Run: `cd engine && uv run pytest ../tests/engine/unit/test_detector_campaign_scaling_opportunity.py -v`
Expected: PASS for `test_threshold_constant_is_25_usd` always; the DB-gated tests PASS when `TEST_DATABASE_URL` is set, else SKIP. To run them with a DB:

Run: `tests/engine/scripts/test-db.sh up && TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/calderyn_test uv run pytest ../tests/engine/unit/test_detector_campaign_scaling_opportunity.py -v`
Expected: 4 passed.

- [ ] **Step 6: Commit**

```bash
git add engine/calderyn_engine/detectors/campaign_scaling_opportunity.py tests/engine/unit/test_detector_campaign_scaling_opportunity.py tests/engine/conftest.py
git commit -m "engine/detectors: campaign_scaling_opportunity emits scale alerts for winners"
```

---

## Task 5: Register the detector in the pipeline

**Files:**
- Modify: `engine/calderyn_engine/pipeline.py:56-69`

- [ ] **Step 1: Add the import**

In the eager-import block at `pipeline.py:56`, add `campaign_scaling_opportunity` (keep alphabetical-ish order with the others):

```python
from calderyn_engine.detectors import (  # noqa: E402, F401
    ad_tax_overload,
    campaign_below_breakeven,
    campaign_scaling_opportunity,
    cogs_drift,
    margin_erosion,
    negative_unit_economics,
    regional_shortage_risk,
    regional_spend_starved_stock,
    reorder_timing,
    return_rate_hidden_loss,
    scaling_sku_fulfillment_risk,
    sku_stockout_vs_spend,
    wrong_location_concentration,
)
```

- [ ] **Step 2: Verify it registers**

Run: `cd engine && uv run python -c "import calderyn_engine.pipeline; from calderyn_engine.detectors import registered_ids; print('campaign_scaling_opportunity' in registered_ids())"`
Expected: `True`

- [ ] **Step 3: Commit**

```bash
git add engine/calderyn_engine/pipeline.py
git commit -m "engine/pipeline: register campaign_scaling_opportunity detector"
```

---

## Task 6: TypeScript unions — ActionKind + DetectorId

**Files:**
- Modify: `app/lib/types.ts:5-15` (ActionKind), `app/lib/types.ts:16-29` (DetectorId)

- [ ] **Step 1: Add `increase_campaign_budget` to `ActionKind`**

In `app/lib/types.ts`, add the member after `reduce_campaign_budget`:

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
  | "snooze_alert";
```

- [ ] **Step 2: Add `campaign_scaling_opportunity` to `DetectorId`**

```typescript
export type DetectorId =
  | "ad_tax_overload"
  | "campaign_below_breakeven"
  | "campaign_scaling_opportunity"
  | "cogs_drift"
  | "free_shipping_leakage"
  | "margin_erosion"
  | "negative_unit_economics"
  | "regional_shortage_risk"
  | "regional_spend_starved_stock"
  | "reorder_timing"
  | "return_rate_hidden_loss"
  | "scaling_sku_fulfillment_risk"
  | "sku_stockout_vs_spend"
  | "wrong_location_concentration";
```

- [ ] **Step 3: Run typecheck — expect NEW errors that guide Task 7**

Run: `npm run typecheck`
Expected: FAIL — errors that `DETECTOR_LABELS`, `DETECTOR_TERMS`, `DETECTOR_TO_ACTIONS`, `ACTION_LABELS`, `ACTION_VERBS` (in `app/lib/labels.ts`) are missing the new keys. This is the forcing function; Task 7 resolves it. (Do not commit yet — commit after Task 7 so the tree typechecks.)

---

## Task 7: Labels for the new action + detector

**Files:**
- Modify: `app/lib/labels.ts` — `ACTION_LABELS`, `ACTION_VERBS`, `DETECTOR_LABELS`, `DETECTOR_TERMS`, `DETECTOR_TO_ACTIONS`

- [ ] **Step 1: Add the action labels** (after the `reduce_campaign_budget` lines)

In `ACTION_LABELS`:

```typescript
  reduce_campaign_budget: "Reduce campaign budget",
  increase_campaign_budget: "Scale campaign budget",
```

In `ACTION_VERBS`:

```typescript
  reduce_campaign_budget: "Reduced budget",
  increase_campaign_budget: "Scaled budget",
```

- [ ] **Step 2: Add the detector labels** (alphabetical, after `campaign_below_breakeven`)

In `DETECTOR_LABELS`:

```typescript
  campaign_below_breakeven: "Campaign is losing money",
  campaign_scaling_opportunity: "Winning campaign you can scale",
```

In `DETECTOR_TERMS`:

```typescript
  campaign_below_breakeven: "Campaign below breakeven",
  campaign_scaling_opportunity: "Campaign scaling opportunity",
```

- [ ] **Step 3: Add the detector→actions mapping**

In `DETECTOR_TO_ACTIONS`, add:

```typescript
  campaign_scaling_opportunity: ["increase_campaign_budget", "snooze_alert"],
```

- [ ] **Step 4: Run typecheck — expect green**

Run: `npm run typecheck`
Expected: exit 0 (the union members are now satisfied everywhere). If other `Record<ActionKind|DetectorId, …>` maps exist elsewhere, fix those the same way (the errors name the file:line).

- [ ] **Step 5: Commit**

```bash
git add app/lib/types.ts app/lib/labels.ts
git commit -m "types/labels: add increase_campaign_budget + campaign_scaling_opportunity"
```

---

## Task 8: `increase_campaign_budget` executable (TDD)

**Files:**
- Test: `app/lib/actions/__tests__/execute.test.ts` (add cases)
- Modify: `app/lib/actions/execute.server.ts:14` (ExecutableKind), `:180-185` (validation), `:204-209` (post-state)
- Modify: the recovered-dollars helper(s) referenced at `execute.server.ts:68-95` so an increase recovers $0.

- [ ] **Step 1: Write the failing tests**

In `app/lib/actions/__tests__/execute.test.ts`, mirror the existing `reduce_campaign_budget` test (the file already mocks `ad_campaign_dim`/`alerts`/`action_audit`). Add:

```typescript
  it("increase_campaign_budget mirrors the new budget and records $0 recovered", async () => {
    const { sb, calls } = fakeSb({ campaign: { id: CAMP, shop_id: SHOP, external_id: "x", platform: "meta", status: "active", daily_budget_cents: 5000 } });
    await executeAction(SHOP, { alertId: null, kind: "increase_campaign_budget", campaignId: CAMP, idempotencyKey: "kib", dailyBudgetCents: 6000 }, sb);
    const audit = calls.inserts.find((i) => i.table === "action_audit");
    expect((audit?.rows as Record<string, unknown>).action_kind).toBe("increase_campaign_budget");
    expect((audit?.rows as Record<string, unknown>).post_state).toMatchObject({ daily_budget_cents: 6000, status: "active" });
    // A budget increase recovers no prior loss.
    expect((audit?.rows as Record<string, unknown>).dollar_impact_at_exec).toBe(0);
  });

  it("increase_campaign_budget refuses a missing target budget", async () => {
    const { sb } = fakeSb({ campaign: { id: CAMP, shop_id: SHOP, external_id: "x", platform: "meta", status: "active", daily_budget_cents: 5000 } });
    await expect(
      executeAction(SHOP, { alertId: null, kind: "increase_campaign_budget", campaignId: CAMP, idempotencyKey: "kib2" }, sb),
    ).rejects.toThrow(/no positive dailyBudgetCents/);
  });
```

> Match the exact `fakeSb(...)` signature/shape already used in this file (see the existing `reduce_campaign_budget` test ~line 120). If the helper differs, adapt the setup call, not the assertions.

- [ ] **Step 2: Run, verify failure**

Run: `npx vitest run app/lib/actions/__tests__/execute.test.ts`
Expected: FAIL — `increase_campaign_budget` not assignable to `ExecutableKind`, and the post-state assertion fails (status would be "paused" via the current fallthrough).

- [ ] **Step 3: Add the kind to `ExecutableKind`**

`app/lib/actions/execute.server.ts:14`:

```typescript
export type ExecutableKind =
  | "pause_campaign"
  | "resume_campaign"
  | "reduce_campaign_budget"
  | "increase_campaign_budget";
```

- [ ] **Step 4: Extend the input validation** (`execute.server.ts:180-185`)

Both budget kinds require a positive target. Replace the existing guard:

```typescript
  // 0. Validate input: a missing/zero target budget must refuse loudly —
  // the old `?? 0` fallthrough would set the live campaign budget to $0.
  if (
    (input.kind === "reduce_campaign_budget" || input.kind === "increase_campaign_budget") &&
    !input.dailyBudgetCents
  ) {
    throw new Error(
      `${input.kind} for ${input.campaignId} has no positive dailyBudgetCents (alert evidence lacked the current budget)`,
    );
  }
```

- [ ] **Step 5: Extend the post-state** (`execute.server.ts:204-209`)

Treat increase like reduce (budget changes, status unchanged):

```typescript
  const postState =
    input.kind === "reduce_campaign_budget" || input.kind === "increase_campaign_budget"
      ? { status: camp.status, daily_budget_cents: input.dailyBudgetCents ?? null }
      : input.kind === "resume_campaign"
        ? { status: "active", daily_budget_cents: camp.daily_budget_cents }
        : { status: "paused", daily_budget_cents: camp.daily_budget_cents };
```

> The adapter-call branch needs no change: the `else` already calls `adapter.setDailyBudget(externalId, input.dailyBudgetCents ?? 0)`, which serves both budget directions.

- [ ] **Step 6: Make the recovered-dollars math treat an increase as $0**

Open the helpers referenced at `execute.server.ts:68-95` — `recoveredDollarsForAlertAction` calls `recoveredCentsForAction(actionKind, atStakeCents)`, and the no-alert path calls `recoveredCentsFromStates(actionKind, pre, post)`. Find both (grep `recoveredCentsForAction` and `recoveredCentsFromStates`). Ensure `increase_campaign_budget` maps to **0** recovered (a budget increase recovers no past loss). If either is a `switch`/`Record<ActionKind, …>`, `tsc` will already require the new key — add it returning `0`. If it has a default branch, confirm the default is `0` for `increase_campaign_budget` and add an explicit case for clarity.

Run: `npm run typecheck`
Expected: exit 0 (or, if a `Record<ActionKind, …>` flagged the missing key, after you add the `increase_campaign_budget: 0` entry).

- [ ] **Step 7: Run the tests, verify they pass**

Run: `npx vitest run app/lib/actions/__tests__/execute.test.ts`
Expected: PASS (including the two new cases).

- [ ] **Step 8: Commit**

```bash
git add app/lib/actions/execute.server.ts app/lib/actions/__tests__/execute.test.ts
git commit -m "actions/execute: increase_campaign_budget executable (mirrors reduce, $0 recovered)"
```

---

## Task 9: Guardrail — increase-% + daily ceiling (TDD)

**Files:**
- Test: `app/lib/actions/__tests__/guardrails.test.ts` (add cases)
- Modify: `app/lib/actions/guardrails.ts:10-20` (`AutopilotGuardrails`), `:47-75` (`evaluateGuardrails`)

`GuardrailFacts` already carries `currentBudgetCents`/`newBudgetCents`; no change there. `GuardedKind = ExecutableKind | "reallocate_budget"` already includes the new kind (Task 8 widened `ExecutableKind`).

- [ ] **Step 1: Write the failing tests**

In `app/lib/actions/__tests__/guardrails.test.ts`, the base `cfg` lacks the new fields — add them to the local `cfg` object in the test and add cases:

```typescript
const cfg: AutopilotGuardrails = {
  enabled: true,
  dailyActionCap: 3,
  minSpendCents: 20000,
  maxBudgetCutPct: 50,
  maxBudgetIncreasePct: 20,
  maxDailyBudgetCents: null,
  dollarCapCents: 1000000,
  cooldownMinutes: 30,
  businessHoursOnly: false,
  businessHoursStartUtc: 14,
  businessHoursEndUtc: 0,
};
```

```typescript
  it("allows an increase within the max increase %", () => {
    // 10000 -> 12000 is +20%, cap is 20%.
    const r = evaluateGuardrails(cfg, { ...facts, kind: "increase_campaign_budget", currentBudgetCents: 10000, newBudgetCents: 12000 });
    expect(r).toEqual({ allowed: true });
  });

  it("blocks an increase beyond the max increase %", () => {
    // 10000 -> 13000 is +30% > 20% cap.
    const r = evaluateGuardrails(cfg, { ...facts, kind: "increase_campaign_budget", currentBudgetCents: 10000, newBudgetCents: 13000 });
    expect(r).toEqual({ allowed: false, reason: "budget increase exceeds max" });
  });

  it("blocks an increase above the daily ceiling when one is set", () => {
    const ceil: AutopilotGuardrails = { ...cfg, maxDailyBudgetCents: 11000 };
    // +10% to 11000 is within the % cap but hits the $110 daily ceiling.
    const r = evaluateGuardrails(ceil, { ...facts, kind: "increase_campaign_budget", currentBudgetCents: 10000, newBudgetCents: 11000 });
    expect(r).toEqual({ allowed: false, reason: "budget exceeds daily ceiling" });
  });
```

- [ ] **Step 2: Run, verify failure**

Run: `npx vitest run app/lib/actions/__tests__/guardrails.test.ts`
Expected: FAIL — `maxBudgetIncreasePct`/`maxDailyBudgetCents` not on `AutopilotGuardrails`, and the increase cases pass through to `{ allowed: true }`.

- [ ] **Step 3: Extend `AutopilotGuardrails`** (`guardrails.ts:10-20`)

```typescript
export interface AutopilotGuardrails {
  enabled: boolean;
  dailyActionCap: number;
  minSpendCents: number;
  maxBudgetCutPct: number;
  maxBudgetIncreasePct: number;
  /** Hard per-campaign daily-budget ceiling; null = no ceiling. */
  maxDailyBudgetCents: number | null;
  dollarCapCents: number;
  cooldownMinutes: number;
  businessHoursOnly: boolean;
  businessHoursStartUtc: number; // 0-23
  businessHoursEndUtc: number;   // 0-23 (may wrap past midnight)
}
```

- [ ] **Step 4: Add the increase check** to `evaluateGuardrails` (`guardrails.ts`), right after the existing cut-% block (around line 70, before the business-hours check):

```typescript
  if (
    facts.kind === "increase_campaign_budget" &&
    facts.currentBudgetCents != null &&
    facts.currentBudgetCents > 0 &&
    facts.newBudgetCents != null
  ) {
    const increasePct = (facts.newBudgetCents / facts.currentBudgetCents - 1) * 100;
    if (increasePct > cfg.maxBudgetIncreasePct + 1e-9) {
      return { allowed: false, reason: "budget increase exceeds max" };
    }
    if (cfg.maxDailyBudgetCents != null && facts.newBudgetCents > cfg.maxDailyBudgetCents) {
      return { allowed: false, reason: "budget exceeds daily ceiling" };
    }
  }
```

- [ ] **Step 5: Run, verify pass**

Run: `npx vitest run app/lib/actions/__tests__/guardrails.test.ts`
Expected: PASS (existing + 3 new).

- [ ] **Step 6: Commit**

```bash
git add app/lib/actions/guardrails.ts app/lib/actions/__tests__/guardrails.test.ts
git commit -m "actions/guardrails: cap autopilot budget increases (% + daily ceiling)"
```

---

## Task 10: Load the new caps from guardrail_config (TDD)

**Files:**
- Test: `app/lib/actions/__tests__/guardrails-server.test.ts` (add fields to the config fixture + assert mapping)
- Modify: `app/lib/actions/guardrails.server.ts:59-72` (the SELECT string + the `AutopilotGuardrails` mapping — note this mapping appears **twice** in the file; update both, or DRY them if trivial)

- [ ] **Step 1: Update the test fixture + add an assertion**

In `app/lib/actions/__tests__/guardrails-server.test.ts`, add the two columns to the mocked `guardrail_config` row (`config` object near line 9):

```typescript
const config = {
  autopilot_enabled: true, autopilot_daily_action_cap: 3, autopilot_min_spend_cents: 20000,
  autopilot_max_budget_cut_pct: 50, autopilot_max_budget_increase_pct: 20, autopilot_max_daily_budget_cents: null,
  dollar_impact_cap_without_2fa: 10000, cooldown_minutes_per_campaign: 30,
  business_hours_only: false, business_hours_start_utc: 14, business_hours_end_utc: 0,
};
```

Add a case that an increase beyond the loaded cap is blocked end-to-end (mirror the existing cut test in this file):

```typescript
  it("loads the increase cap and blocks an over-cap increase", async () => {
    // current 10000 -> new 13000 is +30% > the 20% configured cap.
    const r = await checkGuardrails(SHOP, {
      kind: "increase_campaign_budget", campaignId: CAMP,
      dollarImpactCents: 10000, campaignSpendCents: 50000,
      currentBudgetCents: 10000, newBudgetCents: 13000,
    }, sb);
    expect(r).toEqual({ allowed: false, reason: "budget increase exceeds max" });
  });
```

> Use the same `SHOP`/`CAMP`/`sb` setup already present in this test file; if `CheckInput` doesn't yet permit `increase_campaign_budget`, it will once `GuardedKind` is widened (already done in Task 8).

- [ ] **Step 2: Run, verify failure**

Run: `npx vitest run app/lib/actions/__tests__/guardrails-server.test.ts`
Expected: FAIL — the mapping doesn't populate `maxBudgetIncreasePct`/`maxDailyBudgetCents`, so the increase is wrongly allowed.

- [ ] **Step 3: Add the columns to the SELECT** (both occurrences, `guardrails.server.ts:60`)

```typescript
    .select(
      "autopilot_enabled, autopilot_daily_action_cap, autopilot_min_spend_cents, autopilot_max_budget_cut_pct, autopilot_max_budget_increase_pct, autopilot_max_daily_budget_cents, dollar_impact_cap_without_2fa, cooldown_minutes_per_campaign, business_hours_only, business_hours_start_utc, business_hours_end_utc",
    )
```

- [ ] **Step 4: Map the columns** into both `AutopilotGuardrails` literals (after `maxBudgetCutPct`, `guardrails.server.ts:71`)

```typescript
    maxBudgetCutPct: Number(row.autopilot_max_budget_cut_pct ?? 0),
    maxBudgetIncreasePct: Number(row.autopilot_max_budget_increase_pct ?? 20),
    maxDailyBudgetCents:
      row.autopilot_max_daily_budget_cents == null
        ? null
        : Number(row.autopilot_max_daily_budget_cents),
```

- [ ] **Step 5: Run, verify pass**

Run: `npx vitest run app/lib/actions/__tests__/guardrails-server.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/lib/actions/guardrails.server.ts app/lib/actions/__tests__/guardrails-server.test.ts
git commit -m "actions/guardrails.server: load budget-increase caps from guardrail_config"
```

---

## Task 11: Wire scale into autopilot (TDD)

**Files:**
- Test: `app/lib/actions/__tests__/autopilot.test.ts` (add cases)
- Modify: `app/lib/actions/autopilot.server.ts`

Behaviour: read `autopilot_max_budget_increase_pct` + `autopilot_max_daily_budget_cents` from config; process **defensive** candidates (pause/reduce/reallocate) before **scale** candidates; for a scale candidate compute `target = round(current * (1 + incPct/100))`, clamp to the ceiling, skip if `target <= current`; run `checkGuardrails` then `executeAction("increase_campaign_budget", target)`.

- [ ] **Step 1: Write the failing tests**

In `app/lib/actions/__tests__/autopilot.test.ts`, add a scale candidate and cases (mirror the existing `ad_tax_overload` reduce test). The `fakeSb` config mock returns `{ autopilot_enabled }`; extend it to also surface the new caps (see Step 4 note):

```typescript
  it("scales a winning campaign within the increase cap", async () => {
    checkGuardrails.mockResolvedValue({ allowed: true });
    const scale = { ...candidate, detector_id: "campaign_scaling_opportunity", dollar_impact: 300 };
    const sb = fakeSb({ enabled: true, alerts: [scale] });
    await runAutopilotForShop(SHOP, sb);
    // default +20% of 10000 -> 12000
    expect(executeAction).toHaveBeenCalledWith(
      SHOP,
      expect.objectContaining({ kind: "increase_campaign_budget", dailyBudgetCents: 12000, actor: "autopilot" }),
      sb,
    );
  });

  it("processes defensive actions before scale actions", async () => {
    checkGuardrails.mockResolvedValue({ allowed: true });
    const scale = { ...candidate, alert_id: "al-scale", detector_id: "campaign_scaling_opportunity", dollar_impact: 999 };
    const pause = { ...candidate, alert_id: "al-pause", detector_id: "campaign_below_breakeven", dollar_impact: 10 };
    // Scale has the higher dollar_impact, but defensive must run first.
    const sb = fakeSb({ enabled: true, alerts: [scale, pause] });
    await runAutopilotForShop(SHOP, sb);
    const kinds = executeAction.mock.calls.map((c) => (c[1] as { kind: string }).kind);
    expect(kinds).toEqual(["pause_campaign", "increase_campaign_budget"]);
  });
```

- [ ] **Step 2: Run, verify failure**

Run: `npx vitest run app/lib/actions/__tests__/autopilot.test.ts`
Expected: FAIL — scale candidates are skipped (`if (!kind) continue`), so `executeAction` is never called with `increase_campaign_budget`.

- [ ] **Step 3: Add the SCALE detector set + load the caps**

In `app/lib/actions/autopilot.server.ts`, add near the other detector sets (line 12-13):

```typescript
const PAUSE_DETECTORS = new Set(["campaign_below_breakeven", "negative_unit_economics"]);
const BUDGET_DETECTORS = new Set(["ad_tax_overload"]);
const SCALE_DETECTORS = new Set(["campaign_scaling_opportunity"]);
const DEFAULT_MAX_CUT_PCT = 50;
const DEFAULT_MAX_INCREASE_PCT = 20;
```

Extend the config read (line 39-46) to fetch the new caps:

```typescript
  const { data: cfg, error: cErr } = await sb
    .from("guardrail_config")
    .select("autopilot_enabled, autopilot_max_budget_cut_pct, autopilot_max_budget_increase_pct, autopilot_max_daily_budget_cents")
    .eq("shop_id", shopId)
    .maybeSingle();
  if (cErr) throw cErr;
  if (!cfg || !cfg.autopilot_enabled) return { skipped: true, acted: 0, blocked: 0 };

  const maxCutPct = Number(cfg.autopilot_max_budget_cut_pct ?? DEFAULT_MAX_CUT_PCT);
  const maxIncreasePct = Number(cfg.autopilot_max_budget_increase_pct ?? DEFAULT_MAX_INCREASE_PCT);
  const maxDailyBudgetCents =
    cfg.autopilot_max_daily_budget_cents == null ? null : Number(cfg.autopilot_max_daily_budget_cents);
```

- [ ] **Step 4: Order candidates defensive-first**

Right after `const candidates = (rows ?? []) as Candidate[];` (line 54), replace the iteration source with a partitioned order so scale runs last:

```typescript
  const candidates = (rows ?? []) as Candidate[];
  // Defensive actions (pause/reduce/reallocate) take priority over offensive
  // scale-ups so loss-prevention is never starved of the daily action cap by a
  // bigger-dollar scale opportunity. Each subgroup keeps its dollar_impact order.
  const ordered = [
    ...candidates.filter((c) => !SCALE_DETECTORS.has(c.detector_id)),
    ...candidates.filter((c) => SCALE_DETECTORS.has(c.detector_id)),
  ];
```

Then change the loop header from `for (const c of candidates)` to `for (const c of ordered)`.

- [ ] **Step 5: Handle the scale kind in the loop**

In the detector→kind mapping (line 65-68), add the scale branch:

```typescript
    let kind: ExecutableKind | null = null;
    if (PAUSE_DETECTORS.has(c.detector_id)) kind = "pause_campaign";
    else if (BUDGET_DETECTORS.has(c.detector_id)) kind = "reduce_campaign_budget";
    else if (SCALE_DETECTORS.has(c.detector_id)) kind = "increase_campaign_budget";
    if (!kind) continue;

    const currentBudgetCents = c.daily_budget_cents ?? null;
```

Add a scale block BEFORE the existing reallocation/reduce logic (it must compute its own target and short-circuit). Insert right after `const currentBudgetCents = ...`:

```typescript
    // Offensive scale-up: raise a winner's budget by the configured step,
    // clamped to the optional daily ceiling. Needs a known current budget.
    if (kind === "increase_campaign_budget") {
      if (!currentBudgetCents) {
        console.info(`[autopilot] blocked scale on ${c.campaign_id}: current daily budget is ${currentBudgetCents == null ? "missing from sync" : "$0"}`);
        blocked += 1;
        continue;
      }
      let target = Math.round(currentBudgetCents * (1 + maxIncreasePct / 100));
      if (maxDailyBudgetCents != null) target = Math.min(target, maxDailyBudgetCents);
      if (target <= currentBudgetCents) {
        console.info(`[autopilot] skipped scale on ${c.campaign_id}: already at/above the daily ceiling`);
        blocked += 1;
        continue;
      }
      const verdict = await checkGuardrails(
        shopId,
        {
          kind: "increase_campaign_budget",
          campaignId: c.campaign_id,
          dollarImpactCents: Math.round(Number(c.dollar_impact) * 100),
          campaignSpendCents: c.campaign_spend_cents,
          currentBudgetCents,
          newBudgetCents: target,
        },
        sb,
      );
      if (!verdict.allowed) {
        blocked += 1;
        continue;
      }
      await executeAction(
        shopId,
        {
          alertId: c.alert_id,
          kind: "increase_campaign_budget",
          campaignId: c.campaign_id,
          idempotencyKey: `autopilot:${c.alert_id}:increase_campaign_budget`,
          dailyBudgetCents: target,
          actor: "autopilot",
          triggerReason: autopilotReason("Auto scale budget", c.detector_id, c.dollar_impact),
        },
        sb,
      );
      acted += 1;
      continue;
    }
```

> Place this block so it runs before the `reduce_campaign_budget`-specific guards (the `if (kind === "reduce_campaign_budget" && !currentBudgetCents)` checks). Because it ends in `continue`, the reduce/reallocate logic below is untouched for scale candidates.

- [ ] **Step 6: Run, verify pass**

Run: `npx vitest run app/lib/actions/__tests__/autopilot.test.ts`
Expected: PASS (existing + 2 new). If `fakeSb`'s `maybeSingle` mock only returns `{ autopilot_enabled }`, extend it to also return the cap fields (add them to the mocked object so `maxIncreasePct` resolves to 20, not NaN).

- [ ] **Step 7: Full backend gate**

Run: `npm run typecheck && npm run lint && npx vitest run app/lib/actions && cd engine && uv run pytest ../tests/engine/unit/test_estimator_scale_upside.py ../tests/engine/unit/test_detector_campaign_scaling_opportunity.py -v`
Expected: typecheck exit 0; lint exit 0 (no warnings on touched files); vitest all pass; pytest pass (DB-gated detector tests skip without `TEST_DATABASE_URL`).

- [ ] **Step 8: Commit**

```bash
git add app/lib/actions/autopilot.server.ts app/lib/actions/__tests__/autopilot.test.ts
git commit -m "actions/autopilot: scale winners via increase_campaign_budget (defensive-first)"
```

---

## Plan 1 Self-Review checklist (run before handing off)

- [ ] Spec coverage: detector (Task 4), estimator (Task 3), `increase_campaign_budget` executable (Task 8), guardrail caps (Tasks 1/9/10), autopilot wiring incl. defensive-first (Task 11), view + columns migrations (Tasks 1/2), labels/types (Tasks 6/7). UI is Plan 2 (out of scope here).
- [ ] No placeholders: every code step has real code; every run step has an expected result.
- [ ] Type consistency: `increase_campaign_budget` used identically in `ExecutableKind`, `ActionKind`, guardrails, autopilot, execute; `campaign_scaling_opportunity` identical in `DetectorId`, labels, detector `DETECTOR_ID`, the view, and the pipeline import.
- [ ] Full gate green per CLAUDE.md (typecheck, lint, build, pytest); migrations applied to Supabase via MCP/CLI.

**Next:** Plan 2 (`...-2-ui.md`) — settings plumbing + Polaris extension + dashboard mirror.
