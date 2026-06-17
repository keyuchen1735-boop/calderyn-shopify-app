# Moat Reward Derivation (Slice #2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the per-`(shop, detector)` reward-input **read layer** — a single async function `derive_reward_inputs(conn, shop_id, *, since=None)` that joins `public.alerts ⋈ public.alert_feedback`, maps `alert_feedback.kind` 1:1 onto `compute_reward`'s `feedback_kind`, and yields frozen `RewardInput` rows for the slice #3 trainer to consume.

**Architecture:** One new module `engine/calderyn_engine/moat/reward_inputs.py` containing a frozen `RewardInput` dataclass (the seam) and one public async function that runs a single SQL `fetch` then builds rows in Python (the only Python-side computation is `days_to_confirm` floor + `Decimal` pass-through). It mirrors the canonical sibling `engine/calderyn_engine/moat/peer_baselines.py`: bare `conn` (caller owns the transaction), explicit `shop_id` filter (no RLS dependency), no writes, no pseudonymization (per-shop path, invariant A5). Production code does **not** import `compute_reward`; the trainer (#3) calls it.

**Tech Stack:** Python 3.11, asyncpg, `pytest` + `pytest-asyncio`, `Decimal` fixtures. DB-backed tests use the `pg_pool` fixture from `tests/engine/conftest.py` (skips unless a loopback `TEST_DATABASE_URL` is set). No new third-party dependencies.

## Global Constraints

- **Do not contradict the umbrella contract** (`docs/superpowers/specs/2026-06-16-moat-loop-closure-design.md`). The seam shape and the `feedback_kind` mapping pinned here become part of the shared contract.
- **Mapping is the IDENTITY function.** `feedback_kind` enum = `('confirmed_loss','false_positive','already_handled')`, identical to `compute_reward`'s expected strings. Pass the enum label through verbatim — no translation table, no `match`. (Source: `tests/engine/schema/migrations/20260430000020_alerts_and_context.sql:43`.)
- **Invariant A5:** this is the per-shop path — read raw `public.alerts`/`public.alert_feedback` scoped to one `shop_id`; emit a **raw** `shop_id` on the seam. Do **not** pseudonymize, do **not** consult `peer_data_consent`, do **not** touch `moat.*`. (Slice #3 pseudonymizes at `detection_models` write time.)
- **`action_audit` is RESERVED, not a v1 signal.** Do not read it. The seam carries `alert_id` so a future secondary signal can join it back additively.
- **`days_to_confirm` is reserved** (compute_reward ignores it in v1, umbrella §8). Still compute it for the seam.
- **Surgical:** create exactly one source file and two test files. Do not modify any other `.py`/`.ts` source. Do not touch other slices' files.
- **Seam types are frozen across tasks:** `RewardInput(shop_id: str, detector_id: str, feedback_kind: str, dollar_impact: Decimal, days_to_confirm: int, alert_id: str)`; `derive_reward_inputs(conn, shop_id: str, *, since: datetime | None = None) -> list[RewardInput]`. These names/types are identical in every task below.

---

## Task 1: `RewardInput` dataclass + pin the identity mapping (pure, no DB)

**Files:**
- Create: `engine/calderyn_engine/moat/reward_inputs.py`
- Test: `tests/engine/moat/test_reward_inputs_mapping.py`

**Interfaces:**
- Consumes: `compute_reward` + `FALSE_POSITIVE_PENALTY` from `engine/calderyn_engine/moat/rewards.py` (test only — to prove the seam composes).
- Produces: `RewardInput` frozen dataclass with fields `shop_id: str, detector_id: str, feedback_kind: str, dollar_impact: Decimal, days_to_confirm: int, alert_id: str`. Slice #3 reads exactly these fields.

- [ ] **Step 1: Write the failing test**

Create `tests/engine/moat/test_reward_inputs_mapping.py`:

```python
"""Slice #2 — pin the alert_feedback.kind -> compute_reward mapping.

Pure, no DB. This is the regression guard for THE CRUX: the three
feedback_kind enum labels are identical to the three strings
compute_reward branches on, so a RewardInput.feedback_kind read straight
off alert_feedback.kind can be passed into compute_reward with no
translation. If the enum ever drifts (a 4th label, or a rename), this
test goes red instead of the trainer silently producing 0 reward.
"""

from __future__ import annotations

from decimal import Decimal

from calderyn_engine.moat.rewards import FALSE_POSITIVE_PENALTY, compute_reward
from calderyn_engine.moat.reward_inputs import RewardInput

# The exact set of labels in feedback_kind (DB enum), per
# tests/engine/schema/migrations/20260430000020_alerts_and_context.sql:43
FEEDBACK_KIND_LABELS = {"confirmed_loss", "false_positive", "already_handled"}


def _make(kind: str, *, impact: Decimal, days: int) -> RewardInput:
    return RewardInput(
        shop_id="00000000-0000-0000-0000-0000000000aa",
        detector_id="sku_stockout_vs_spend",
        feedback_kind=kind,
        dollar_impact=impact,
        days_to_confirm=days,
        alert_id="00000000-0000-0000-0000-0000000000bb",
    )


def test_reward_input_is_frozen() -> None:
    ri = _make("confirmed_loss", impact=Decimal("100"), days=1)
    try:
        ri.feedback_kind = "false_positive"  # type: ignore[misc]
    except Exception as exc:  # FrozenInstanceError subclasses Exception
        assert exc.__class__.__name__ == "FrozenInstanceError"
    else:
        raise AssertionError("RewardInput must be a frozen dataclass")


def test_confirmed_loss_label_feeds_compute_reward_as_positive() -> None:
    ri = _make("confirmed_loss", impact=Decimal("1500"), days=2)
    reward = compute_reward(ri.feedback_kind, ri.dollar_impact, ri.days_to_confirm)
    assert reward == Decimal("1500")


def test_false_positive_label_feeds_compute_reward_as_penalty() -> None:
    ri = _make("false_positive", impact=Decimal("999"), days=0)
    reward = compute_reward(ri.feedback_kind, ri.dollar_impact, ri.days_to_confirm)
    assert reward == FALSE_POSITIVE_PENALTY
    assert reward == Decimal("-10")


def test_already_handled_label_feeds_compute_reward_as_zero() -> None:
    ri = _make("already_handled", impact=Decimal("500"), days=5)
    reward = compute_reward(ri.feedback_kind, ri.dollar_impact, ri.days_to_confirm)
    assert reward == Decimal("0")


def test_every_enum_label_is_a_known_compute_reward_branch() -> None:
    # Identity mapping: each DB enum label, passed verbatim, produces a
    # NON-default reward for the two signal-bearing kinds and the
    # documented 0 for already_handled. Crucially, none of them fall
    # through to compute_reward's "unknown kind -> 0" arm by accident.
    results = {
        label: compute_reward(label, Decimal("100"), 0)
        for label in FEEDBACK_KIND_LABELS
    }
    assert results["confirmed_loss"] == Decimal("100")
    assert results["false_positive"] == Decimal("-10")
    assert results["already_handled"] == Decimal("0")
    # An unmapped label must behave differently from confirmed_loss so the
    # test would catch a typo'd label silently degrading to no-signal.
    assert compute_reward("totally_unknown_kind", Decimal("100"), 0) == Decimal("0")
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
.venv/bin/python -m pytest tests/engine/moat/test_reward_inputs_mapping.py -v
```
Expected: FAIL — collection/import error `ModuleNotFoundError: No module named 'calderyn_engine.moat.reward_inputs'` (the module does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `engine/calderyn_engine/moat/reward_inputs.py`:

```python
"""Slice #2 — per-(shop, detector) reward-input read layer.

``derive_reward_inputs`` joins ``public.alerts`` to ``public.alert_feedback``
and yields one :class:`RewardInput` per feedback row — exactly the fields the
slice #3 trainer needs to call
``compute_reward(feedback_kind, dollar_impact, days_to_confirm)`` and then
pseudonymize ``shop_id`` for the ``moat.detection_models`` write.

This is the PER-SHOP path (umbrella invariant A5): it reads the shop's own raw
domain tables scoped to one ``shop_id`` and emits a RAW ``shop_id`` on the row.
It does NOT pseudonymize, does NOT consult ``peer_data_consent``, and does NOT
touch ``moat.*`` — that anonymized cross-tenant work is slice #5, and the
pseudonymization at model-write time is slice #3.

``alert_feedback.kind`` is the DB enum
``('confirmed_loss','false_positive','already_handled')`` — identical to the
strings ``compute_reward`` branches on — so the label is passed through verbatim
with no translation. ``action_audit`` is a documented RESERVED secondary signal
and is intentionally not read here; the row carries ``alert_id`` so a future
secondary signal can join it back additively.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any

import structlog

logger = structlog.get_logger()


@dataclass(frozen=True)
class RewardInput:
    """One reward signal: a single alert_feedback row joined to its alert."""

    shop_id: str        # raw tenant uuid (A5); slice #3 pseudonymizes at write time
    detector_id: str    # e.g. "sku_stockout_vs_spend" — slice #3 groups by this
    feedback_kind: str  # raw enum label; identity-maps to compute_reward
    dollar_impact: Decimal   # alerts.dollar_impact (numeric -> Decimal)
    days_to_confirm: int     # whole days, >= 0; reserved (compute_reward ignores in v1)
    alert_id: str       # alerts.id — join key for a future action_audit signal


def _days_to_confirm(first_seen_at: datetime, feedback_at: datetime) -> int:
    """Whole days between alert first-seen and feedback, floored, clamped >= 0."""

    delta = feedback_at - first_seen_at
    return max(int(delta.total_seconds() // 86400), 0)


async def derive_reward_inputs(
    conn: Any,
    shop_id: str,
    *,
    since: datetime | None = None,
) -> list[RewardInput]:
    """Yield one :class:`RewardInput` per alert_feedback row for ``shop_id``.

    Parameters
    ----------
    conn:
        asyncpg connection. The caller owns transaction scope; this function
        only SELECTs and does not BEGIN/COMMIT.
    shop_id:
        Tenant uuid (string form). Scopes the read to this shop's own alerts.
    since:
        Optional inclusive lower bound on ``alert_feedback.created_at`` so the
        nightly trainer can process only feedback newer than its last run.
        ``None`` (default) returns full history.

    Returns
    -------
    list[RewardInput]
        One row per feedback, ordered by feedback time ascending.
    """

    rows = await conn.fetch(
        """
        select
          a.id            as alert_id,
          a.shop_id       as shop_id,
          a.detector_id   as detector_id,
          a.dollar_impact as dollar_impact,
          af.kind::text   as feedback_kind,
          af.created_at   as feedback_at,
          a.first_seen_at as alert_first_seen_at
        from public.alert_feedback af
        join public.alerts a on a.id = af.alert_id
        where a.shop_id = $1::uuid
          and ($2::timestamptz is null or af.created_at >= $2::timestamptz)
        order by af.created_at asc
        """,
        shop_id,
        since,
    )

    inputs = [
        RewardInput(
            shop_id=str(r["shop_id"]),
            detector_id=r["detector_id"],
            feedback_kind=r["feedback_kind"],
            dollar_impact=Decimal(r["dollar_impact"]),
            days_to_confirm=_days_to_confirm(
                r["alert_first_seen_at"], r["feedback_at"]
            ),
            alert_id=str(r["alert_id"]),
        )
        for r in rows
    ]

    if not inputs:
        logger.info("reward_inputs_empty", shop_id=shop_id)
    return inputs
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
.venv/bin/python -m pytest tests/engine/moat/test_reward_inputs_mapping.py -v
```
Expected: PASS — 5 passed. (No DB needed; this file does not use the `pg_pool` fixture.)

- [ ] **Step 5: Commit**

```bash
git add engine/calderyn_engine/moat/reward_inputs.py tests/engine/moat/test_reward_inputs_mapping.py
git commit -m "moat/reward_inputs: RewardInput seam + pin alert_feedback.kind identity mapping"
```

---

## Task 2: `derive_reward_inputs` join — happy path (DB-backed)

**Files:**
- Modify: `engine/calderyn_engine/moat/reward_inputs.py` (already complete from Task 1 — this task adds DB coverage; no source change expected)
- Test: `tests/engine/moat/test_reward_inputs_derive.py`

**Interfaces:**
- Consumes: `derive_reward_inputs(conn, shop_id, *, since=None) -> list[RewardInput]` and `RewardInput` from Task 1.
- Produces: nothing new — this task proves the Task 1 SQL actually joins `alerts ⋈ alert_feedback` and carries `detector_id` / `dollar_impact` / `feedback_kind` / `alert_id` correctly against a real Postgres.

- [ ] **Step 1: Write the failing test**

Create `tests/engine/moat/test_reward_inputs_derive.py`:

```python
"""Slice #2 — DB-backed coverage of derive_reward_inputs.

Uses the real testcontainer pg fixture (``pg_pool``) so we exercise the
actual alerts ⋈ alert_feedback join. Skips unless a local
TEST_DATABASE_URL is set (see tests/engine/conftest.py). Seeds shops ->
alerts -> alert_feedback directly, the same way test_peer_baselines.py
seeds shops -> moat.event_log.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, UTC
from decimal import Decimal

import pytest

from calderyn_engine.moat.reward_inputs import RewardInput, derive_reward_inputs


async def _seed_shop(conn, shop_id: str) -> None:
    suffix = shop_id.replace("-", "")[-12:]
    await conn.execute(
        "INSERT INTO public.shops (id, shop_domain) VALUES ($1::uuid, $2) "
        "ON CONFLICT (id) DO NOTHING",
        shop_id,
        f"ri-{suffix}.myshopify.com",
    )


async def _seed_alert(
    conn,
    *,
    shop_id: str,
    detector_id: str,
    dollar_impact: Decimal,
    first_seen_at: datetime,
) -> str:
    alert_id = str(uuid.uuid4())
    await conn.execute(
        """
        INSERT INTO public.alerts
          (id, shop_id, detector_id, entity_ref, dollar_impact,
           day_bucket, first_seen_at, last_seen_at)
        VALUES ($1::uuid, $2::uuid, $3, '{}'::jsonb, $4,
                $5::date, $5, $5)
        """,
        alert_id,
        shop_id,
        detector_id,
        dollar_impact,
        first_seen_at,
    )
    return alert_id


async def _seed_feedback(
    conn,
    *,
    alert_id: str,
    shop_id: str,
    kind: str,
    created_at: datetime,
) -> None:
    await conn.execute(
        """
        INSERT INTO public.alert_feedback
          (alert_id, shop_id, kind, created_at)
        VALUES ($1::uuid, $2::uuid, $3::feedback_kind, $4)
        """,
        alert_id,
        shop_id,
        kind,
        created_at,
    )


@pytest.mark.asyncio
async def test_one_reward_input_per_feedback_carries_join_fields(pg_pool) -> None:
    async with pg_pool.acquire() as conn:
        shop_id = str(uuid.uuid4())
        await _seed_shop(conn, shop_id)
        seen = datetime(2026, 6, 1, 12, 0, tzinfo=UTC)
        alert_id = await _seed_alert(
            conn,
            shop_id=shop_id,
            detector_id="campaign_below_breakeven",
            dollar_impact=Decimal("1234.56"),
            first_seen_at=seen,
        )
        await _seed_feedback(
            conn,
            alert_id=alert_id,
            shop_id=shop_id,
            kind="confirmed_loss",
            created_at=seen + timedelta(days=3),
        )

        out = await derive_reward_inputs(conn, shop_id)

        assert len(out) == 1
        ri = out[0]
        assert isinstance(ri, RewardInput)
        assert ri.shop_id == shop_id
        assert ri.alert_id == alert_id
        assert ri.detector_id == "campaign_below_breakeven"
        assert ri.feedback_kind == "confirmed_loss"
        assert ri.dollar_impact == Decimal("1234.56")
        assert ri.days_to_confirm == 3


@pytest.mark.asyncio
async def test_three_feedback_rows_yield_three_inputs_ordered_by_time(pg_pool) -> None:
    async with pg_pool.acquire() as conn:
        shop_id = str(uuid.uuid4())
        await _seed_shop(conn, shop_id)
        seen = datetime(2026, 6, 2, 9, 0, tzinfo=UTC)
        kinds = ["already_handled", "false_positive", "confirmed_loss"]
        for offset, kind in enumerate(kinds):
            alert_id = await _seed_alert(
                conn,
                shop_id=shop_id,
                detector_id="margin_erosion",
                dollar_impact=Decimal("100"),
                first_seen_at=seen,
            )
            await _seed_feedback(
                conn,
                alert_id=alert_id,
                shop_id=shop_id,
                kind=kind,
                created_at=seen + timedelta(hours=offset),
            )

        out = await derive_reward_inputs(conn, shop_id)

        assert [ri.feedback_kind for ri in out] == kinds  # ascending by feedback time
        assert all(ri.detector_id == "margin_erosion" for ri in out)
```

- [ ] **Step 2: Run test to verify it fails (or skips without a DB)**

Run (with a local test DB up — see `tests/engine/scripts/test-db.sh up`):
```bash
TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/calderyn_test \
  .venv/bin/python -m pytest tests/engine/moat/test_reward_inputs_derive.py -v
```
Expected: PASS — 2 passed (the Task 1 implementation already satisfies this). Without `TEST_DATABASE_URL` the run reports `2 skipped` (the `pg_pool` fixture skips). If it FAILS, the join SQL in `reward_inputs.py` is wrong — fix the SQL, not the test.

- [ ] **Step 3: Write minimal implementation**

No source change expected — Task 1's `derive_reward_inputs` already implements the join. If Step 2 surfaced a real failure (e.g. a column-name typo), fix `engine/calderyn_engine/moat/reward_inputs.py` minimally to make the join return the seeded rows. Do not add fields to `RewardInput`.

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/calderyn_test \
  .venv/bin/python -m pytest tests/engine/moat/test_reward_inputs_derive.py -v
```
Expected: PASS — 2 passed.

- [ ] **Step 5: Commit**

```bash
git add tests/engine/moat/test_reward_inputs_derive.py engine/calderyn_engine/moat/reward_inputs.py
git commit -m "moat/reward_inputs: DB-backed coverage of alerts ⋈ alert_feedback join"
```

---

## Task 3: `days_to_confirm` boundaries + per-shop isolation (DB-backed)

**Files:**
- Modify: `engine/calderyn_engine/moat/reward_inputs.py` (only if a boundary test fails)
- Test: `tests/engine/moat/test_reward_inputs_derive.py` (append tests)

**Interfaces:**
- Consumes: `derive_reward_inputs`, `RewardInput`, and the `_seed_*` helpers from Task 2 (same file).
- Produces: nothing new — hardens the `days_to_confirm` floor/clamp and the `where a.shop_id = $1` scope.

- [ ] **Step 1: Write the failing test**

Append to `tests/engine/moat/test_reward_inputs_derive.py`:

```python
@pytest.mark.asyncio
async def test_days_to_confirm_floors_partial_days(pg_pool) -> None:
    # 47 hours between alert and feedback must floor to 1 whole day.
    async with pg_pool.acquire() as conn:
        shop_id = str(uuid.uuid4())
        await _seed_shop(conn, shop_id)
        seen = datetime(2026, 6, 3, 0, 0, tzinfo=UTC)
        alert_id = await _seed_alert(
            conn,
            shop_id=shop_id,
            detector_id="cogs_drift",
            dollar_impact=Decimal("50"),
            first_seen_at=seen,
        )
        await _seed_feedback(
            conn,
            alert_id=alert_id,
            shop_id=shop_id,
            kind="confirmed_loss",
            created_at=seen + timedelta(hours=47),
        )

        out = await derive_reward_inputs(conn, shop_id)

        assert len(out) == 1
        assert out[0].days_to_confirm == 1


@pytest.mark.asyncio
async def test_feedback_before_alert_clamps_days_to_zero(pg_pool) -> None:
    # Clock skew / backfill: feedback timestamp precedes first_seen_at.
    # days_to_confirm must clamp to 0, never go negative.
    async with pg_pool.acquire() as conn:
        shop_id = str(uuid.uuid4())
        await _seed_shop(conn, shop_id)
        seen = datetime(2026, 6, 4, 12, 0, tzinfo=UTC)
        alert_id = await _seed_alert(
            conn,
            shop_id=shop_id,
            detector_id="cogs_drift",
            dollar_impact=Decimal("50"),
            first_seen_at=seen,
        )
        await _seed_feedback(
            conn,
            alert_id=alert_id,
            shop_id=shop_id,
            kind="confirmed_loss",
            created_at=seen - timedelta(hours=5),
        )

        out = await derive_reward_inputs(conn, shop_id)

        assert len(out) == 1
        assert out[0].days_to_confirm == 0


@pytest.mark.asyncio
async def test_other_shops_feedback_is_not_returned(pg_pool) -> None:
    # Per-shop scope: shop B's feedback must never appear in shop A's rows.
    async with pg_pool.acquire() as conn:
        shop_a = str(uuid.uuid4())
        shop_b = str(uuid.uuid4())
        await _seed_shop(conn, shop_a)
        await _seed_shop(conn, shop_b)
        seen = datetime(2026, 6, 5, 8, 0, tzinfo=UTC)

        a_alert = await _seed_alert(
            conn,
            shop_id=shop_a,
            detector_id="ad_tax_overload",
            dollar_impact=Decimal("10"),
            first_seen_at=seen,
        )
        await _seed_feedback(
            conn, alert_id=a_alert, shop_id=shop_a,
            kind="confirmed_loss", created_at=seen + timedelta(days=1),
        )
        b_alert = await _seed_alert(
            conn,
            shop_id=shop_b,
            detector_id="ad_tax_overload",
            dollar_impact=Decimal("9999"),
            first_seen_at=seen,
        )
        await _seed_feedback(
            conn, alert_id=b_alert, shop_id=shop_b,
            kind="false_positive", created_at=seen + timedelta(days=1),
        )

        out_a = await derive_reward_inputs(conn, shop_a)

        assert len(out_a) == 1
        assert out_a[0].shop_id == shop_a
        assert out_a[0].alert_id == a_alert
        assert out_a[0].dollar_impact == Decimal("10")
```

- [ ] **Step 2: Run test to verify it fails (or skips without a DB)**

Run:
```bash
TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/calderyn_test \
  .venv/bin/python -m pytest tests/engine/moat/test_reward_inputs_derive.py -v -k "days_to_confirm or other_shops"
```
Expected: PASS — 3 passed (Task 1's `_days_to_confirm` floor/clamp and the `where a.shop_id = $1` filter already satisfy these). If any FAILS, fix `reward_inputs.py` minimally. Without `TEST_DATABASE_URL` the run reports skips.

- [ ] **Step 3: Write minimal implementation**

No source change expected — Task 1 already floors (`int(delta.total_seconds() // 86400)`), clamps (`max(..., 0)`), and scopes (`where a.shop_id = $1::uuid`). Only edit `engine/calderyn_engine/moat/reward_inputs.py` if Step 2 surfaced a genuine failure.

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/calderyn_test \
  .venv/bin/python -m pytest tests/engine/moat/test_reward_inputs_derive.py -v
```
Expected: PASS — 5 passed (2 from Task 2 + 3 here).

- [ ] **Step 5: Commit**

```bash
git add tests/engine/moat/test_reward_inputs_derive.py engine/calderyn_engine/moat/reward_inputs.py
git commit -m "moat/reward_inputs: cover days_to_confirm floor/clamp + per-shop isolation"
```

---

## Task 4: `since` incremental cutoff (DB-backed)

**Files:**
- Modify: `engine/calderyn_engine/moat/reward_inputs.py` (only if the cutoff test fails)
- Test: `tests/engine/moat/test_reward_inputs_derive.py` (append a test)

**Interfaces:**
- Consumes: `derive_reward_inputs`, `RewardInput`, the `_seed_*` helpers (same file).
- Produces: confirms the `since` keyword filters `alert_feedback.created_at >= since` so slice #4's nightly trainer can process only new feedback.

- [ ] **Step 1: Write the failing test**

Append to `tests/engine/moat/test_reward_inputs_derive.py`:

```python
@pytest.mark.asyncio
async def test_since_cutoff_excludes_older_feedback(pg_pool) -> None:
    async with pg_pool.acquire() as conn:
        shop_id = str(uuid.uuid4())
        await _seed_shop(conn, shop_id)
        seen = datetime(2026, 6, 6, 0, 0, tzinfo=UTC)

        old_alert = await _seed_alert(
            conn, shop_id=shop_id, detector_id="reorder_timing",
            dollar_impact=Decimal("1"), first_seen_at=seen,
        )
        await _seed_feedback(
            conn, alert_id=old_alert, shop_id=shop_id,
            kind="confirmed_loss", created_at=seen + timedelta(days=1),
        )
        new_alert = await _seed_alert(
            conn, shop_id=shop_id, detector_id="reorder_timing",
            dollar_impact=Decimal("2"), first_seen_at=seen,
        )
        await _seed_feedback(
            conn, alert_id=new_alert, shop_id=shop_id,
            kind="confirmed_loss", created_at=seen + timedelta(days=10),
        )

        cutoff = seen + timedelta(days=5)
        out = await derive_reward_inputs(conn, shop_id, since=cutoff)

        assert len(out) == 1
        assert out[0].alert_id == new_alert
        assert out[0].dollar_impact == Decimal("2")


@pytest.mark.asyncio
async def test_since_none_returns_full_history(pg_pool) -> None:
    async with pg_pool.acquire() as conn:
        shop_id = str(uuid.uuid4())
        await _seed_shop(conn, shop_id)
        seen = datetime(2026, 6, 7, 0, 0, tzinfo=UTC)
        for offset in (1, 10):
            alert_id = await _seed_alert(
                conn, shop_id=shop_id, detector_id="reorder_timing",
                dollar_impact=Decimal("1"), first_seen_at=seen,
            )
            await _seed_feedback(
                conn, alert_id=alert_id, shop_id=shop_id,
                kind="confirmed_loss", created_at=seen + timedelta(days=offset),
            )

        out = await derive_reward_inputs(conn, shop_id, since=None)

        assert len(out) == 2
```

- [ ] **Step 2: Run test to verify it fails (or skips without a DB)**

Run:
```bash
TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/calderyn_test \
  .venv/bin/python -m pytest tests/engine/moat/test_reward_inputs_derive.py -v -k "since"
```
Expected: PASS — 2 passed (the `($2::timestamptz is null or af.created_at >= $2::timestamptz)` predicate from Task 1 already implements this). Without `TEST_DATABASE_URL` the run skips. If FAIL, fix the `since` predicate in `reward_inputs.py`.

- [ ] **Step 3: Write minimal implementation**

No source change expected — Task 1's SQL already gates on `since`. Edit `engine/calderyn_engine/moat/reward_inputs.py` only if Step 2 surfaced a real failure.

- [ ] **Step 4: Run the full slice suite to verify everything passes**

Run:
```bash
.venv/bin/python -m pytest tests/engine/moat/test_reward_inputs_mapping.py -v && \
TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/calderyn_test \
  .venv/bin/python -m pytest tests/engine/moat/test_reward_inputs_derive.py -v
```
Expected: PASS — mapping file 5 passed; derive file 7 passed (2 + 3 + 2).

- [ ] **Step 5: Commit**

```bash
git add tests/engine/moat/test_reward_inputs_derive.py engine/calderyn_engine/moat/reward_inputs.py
git commit -m "moat/reward_inputs: cover incremental 'since' cutoff; complete slice #2 producer"
```

---

## Self-Review

**1. Spec coverage** (against `2026-06-16-moat-reward-derivation-spec.md`):
- §3 mapping pin → Task 1 (`test_every_enum_label_is_a_known_compute_reward_branch`, `test_reward_input_is_frozen`).
- §4.2 join / grain → Task 2.
- §4.3 `days_to_confirm` floor + clamp → Task 3.
- §5 `action_audit` reserved → enforced by omission (no `action_audit` read anywhere; `alert_id` present on the seam for the future hook) and documented in the module docstring (Task 1, Step 3).
- §6 seam (`RewardInput` + `derive_reward_inputs` signature) → Task 1 defines it; Tasks 2–4 exercise it.
- §4.2 per-shop scope → Task 3 (`test_other_shops_feedback_is_not_returned`).
- `since` cutoff → Task 4.
- Invariant A5 (raw `shop_id`, no pseudonymization) → asserted by `ri.shop_id == shop_id` (raw uuid) in Tasks 2–3 and by the module never importing `pseudonym`/`moat.*`.

**2. Placeholder scan:** No "TBD"/"TODO"/"add error handling"/"similar to Task N". Every code step shows complete, runnable code. Every run step has an exact command and expected output.

**3. Type consistency:** `RewardInput(shop_id: str, detector_id: str, feedback_kind: str, dollar_impact: Decimal, days_to_confirm: int, alert_id: str)` and `derive_reward_inputs(conn, shop_id: str, *, since: datetime | None = None) -> list[RewardInput]` are byte-identical across the Global Constraints block, Task 1's implementation, and every test. The `_seed_alert` / `_seed_feedback` / `_seed_shop` helper signatures are defined once in Task 2 and reused verbatim in Tasks 3–4 (same file, appended). `feedback_kind` labels are the same three strings everywhere.

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-16-moat-reward-derivation-plan.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
