# Moat Detector Consume — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thread the existing `get_threshold` into the 10 detectors that have a dollar gate so detection reads the learned, peer-informed threshold from `moat.detection_models` / `alert_thresholds`, falling back to the detector's own historical default so behavior is unchanged while the moat is offline.

**Architecture:** Each detector's `detect(shop_id, conn, now)` is already an `async` coroutine holding a live `asyncpg.Connection`, so we add one `await get_threshold(conn, shop_id, DETECTOR_ID)` call at the top of `detect` and feed the returned `Decimal` into the detector's existing dollar gate (SQL bind param for Shape-A detectors, Python `impact <` post-filter for Shape-B, plus any severity multiplier). `get_threshold` reads `MOAT_PEPPER` from the environment itself, so no pepper parameter is plumbed through the registry or `pipeline.py`. The cutover is safe because `get_threshold` falls through to the registry default (and we fall the detector back to its own constant) when there is no pepper / no override row.

**Tech Stack:** Python 3.12, asyncpg, `pytest` + `pytest-asyncio` (explicit `@pytest.mark.asyncio` markers), `Decimal` money, ruff. DB-backed tests run against a local Postgres pointed at by `TEST_DATABASE_URL` (disposable `postgres:17` via `tests/engine/scripts/test-db.sh`).

## Global Constraints

- **Do NOT modify** `engine/calderyn_engine/thresholds.py`, its `_DETECTOR_THRESHOLDS` registry, `engine/calderyn_engine/pipeline.py`, `engine/calderyn_engine/detectors/base.py`, `engine/calderyn_engine/detectors/__init__.py`, or any module under `engine/calderyn_engine/moat/`. This slice touches only the 10 detector bodies and adds/extends their tests.
- **Canonical key per detector is owned by `get_threshold`.** A detector passes its own `DETECTOR_ID` and consumes the returned `Decimal`; it never names `min_spend_usd` / `min_loss_usd` / `min_impact_usd` itself.
- **`get_threshold` is async** with signature `get_threshold(conn, shop_id, detector_id, *, pepper=None) -> Decimal`. Call it with **no** `pepper` kwarg from detectors; it reads `MOAT_PEPPER` from `os.environ`.
- **Zero behavior change while offline (umbrella §3, §5).** When `MOAT_PEPPER` is unset and no override row exists, each detector MUST gate on its **historical** default ($500 for six detectors, $200 for `return_rate_hidden_loss` / `reorder_timing` / `wrong_location_concentration` / `regional_shortage_risk`). Because `_DETECTOR_THRESHOLDS` registers $500 for the four $200 detectors, we keep each detector's own `DEFAULT_THRESHOLD_USD` constant and pass it as the fallback floor (see Task 1 helper and Task 13). **Do not delete the module constant.**
- **Out of scope:** `ad_tax_overload` and `scaling_sku_fulfillment_risk` have no dollar gate (they gate on ratios/days) — leave them byte-for-byte unchanged. Do not invent a dollar gate.
- **Severity multipliers** that read the same constant (`sku_stockout_vs_spend` `× 5`, `campaign_below_breakeven` `× 4`) must read the **fetched** threshold so the boundary tracks the gate.
- **Test command** (DB-backed): `TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/calderyn_test .venv/bin/python -m pytest <path> -q`. DB-free tests run with the same command minus the env var (they skip via the `pg_pool` fixture).
- **Lint:** `.venv/bin/ruff check engine/calderyn_engine/detectors/<file>.py` must be clean on every touched file.
- Frequent commits: one detector (or the shared helper) per commit, after its test cycle is green.

---

## File Structure

**Shared helper (new):**
- Create: `engine/calderyn_engine/detectors/_threshold.py` — a single tiny module-private helper `resolve_threshold(conn, shop_id, detector_id, fallback)` that wraps `get_threshold` and applies the per-detector fallback so the four `$200` detectors keep their historical gate without editing the shared registry. Keeps the swap DRY across 10 detectors and centralizes the Q1 resolution in one place.

**Detector bodies (modify — 10 of 12):**

| # | File | Shape | Edit |
|---|---|---|---|
| Shape A | `engine/calderyn_engine/detectors/sku_stockout_vs_spend.py` | SQL bind + severity ×5 | TRACER (Task 1) |
| Shape A | `engine/calderyn_engine/detectors/regional_spend_starved_stock.py` | SQL bind | Task 5 |
| Shape B | `engine/calderyn_engine/detectors/campaign_below_breakeven.py` | post-filter + severity ×4 | Task 6 |
| Shape B | `engine/calderyn_engine/detectors/margin_erosion.py` | post-filter | Task 7 |
| Shape B | `engine/calderyn_engine/detectors/cogs_drift.py` | post-filter | Task 8 |
| Shape B | `engine/calderyn_engine/detectors/negative_unit_economics.py` | post-filter | Task 9 |
| Shape B | `engine/calderyn_engine/detectors/return_rate_hidden_loss.py` | post-filter ($200) | Task 10 |
| Shape B | `engine/calderyn_engine/detectors/reorder_timing.py` | post-filter ($200) | Task 11 |
| Shape B | `engine/calderyn_engine/detectors/wrong_location_concentration.py` | post-filter ($200) | Task 12 |
| Shape B | `engine/calderyn_engine/detectors/regional_shortage_risk.py` | post-filter ($200) | Task 13 |

**Detectors left UNCHANGED (Shape C — no dollar gate):**
- `engine/calderyn_engine/detectors/ad_tax_overload.py`
- `engine/calderyn_engine/detectors/scaling_sku_fulfillment_risk.py`

**Tests (modify/extend):**
- `tests/engine/unit/test_detector_sku_stockout_vs_spend.py` — add tracer cutover + no-row safety tests (Task 1, Task 4).
- `tests/engine/unit/test_detector_*.py` — add a no-row safety test per threaded detector (Tasks 5–13).
- Reference fixtures (read-only): `tests/engine/conftest.py` (`pg_pool`, `seed_shop`, `seed_stockout_scenario`, `seed_breakeven_scenario`, …).

**Interfaces (consumed, fixed — from `thresholds.py`):**
- `get_threshold(conn: asyncpg.Connection, shop_id: str, detector_id: str, *, pepper: str | None = None) -> Decimal`.
- `_DETECTOR_THRESHOLDS[detector_id] -> (canonical_key: str, default: Decimal)` — read-only; the helper reads the default to detect "no signal".

---

## Task 1: Tracer — `sku_stockout_vs_spend` end-to-end (Shape A) + shared helper

This is the tracer bullet: it builds the shared `resolve_threshold` helper, wires the first detector, and proves BOTH cutover directions (no model row → $500; model row present → learned value). Every later task reuses the helper and the no-row test shape.

**Files:**
- Create: `engine/calderyn_engine/detectors/_threshold.py`
- Modify: `engine/calderyn_engine/detectors/sku_stockout_vs_spend.py:120-155` (the `detect` body)
- Test: `tests/engine/unit/test_detector_sku_stockout_vs_spend.py`

**Interfaces:**
- Consumes: `get_threshold` (above); `_DETECTOR_THRESHOLDS` (read-only, to learn the registry default for the "no signal" check).
- Produces: `resolve_threshold(conn, shop_id, detector_id, fallback) -> Decimal` — reused by Tasks 5–13.

- [ ] **Step 1: Write the failing tracer + safety tests**

Append to `tests/engine/unit/test_detector_sku_stockout_vs_spend.py`. These are DB-backed (skip without `TEST_DATABASE_URL`). The first asserts the offline default is preserved; the second asserts a `moat.detection_models` row moves the gate.

```python
@pytest.mark.asyncio
async def test_threshold_defaults_to_500_when_no_override(
    pg_pool, seed_shop, seed_stockout_scenario, monkeypatch
) -> None:
    """Cutover safety: no MOAT_PEPPER, no override row → gate stays at the
    historical $500. Spend $450 is below $500, so the detector must NOT fire,
    exactly as it did before get_threshold was threaded."""
    monkeypatch.delenv("MOAT_PEPPER", raising=False)
    await seed_shop(SHOP)
    await seed_stockout_scenario(
        SHOP,
        spend_usd=Decimal("450"),  # below $500 default
        stock_on_hand=0,
        velocity=Decimal("1"),
        unit_margin=Decimal("0"),  # estimator → 0, impact falls back to spend
    )
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            results = await detect(SHOP, conn, NOW)
    assert results == []


@pytest.mark.asyncio
async def test_learned_threshold_lowers_gate_so_detector_fires(
    pg_pool, seed_shop, seed_stockout_scenario, monkeypatch
) -> None:
    """Loop closed: a moat.detection_models row at $300 lowers the gate below
    the $450 spend, so the same scenario that did NOT fire at the $500 default
    now fires. Proves the learned value is consumed."""
    from calderyn_engine.moat.pseudonym import pseudonym_for

    pepper = "pepper-tracer-sku-stockout"
    monkeypatch.setenv("MOAT_PEPPER", pepper)
    pseudonym = pseudonym_for(SHOP, pepper)

    await seed_shop(SHOP)
    await seed_stockout_scenario(
        SHOP,
        spend_usd=Decimal("450"),
        stock_on_hand=0,
        velocity=Decimal("1"),
        unit_margin=Decimal("0"),
    )
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            await conn.execute(
                """
                INSERT INTO moat.detection_models
                  (detector_id, shop_id_pseudonym, threshold_json,
                   posterior_json)
                VALUES ('sku_stockout_vs_spend', $1,
                        '{"min_spend_usd": 300}'::jsonb,
                        '{"alpha": 5.0, "beta": 1.0}'::jsonb)
                ON CONFLICT (detector_id, shop_id_pseudonym)
                DO UPDATE SET threshold_json = EXCLUDED.threshold_json,
                              posterior_json = EXCLUDED.posterior_json
                """,
                pseudonym,
            )
            results = await detect(SHOP, conn, NOW)
    assert len(results) == 1
    assert results[0].detector_id == "sku_stockout_vs_spend"
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/calderyn_test .venv/bin/python -m pytest tests/engine/unit/test_detector_sku_stockout_vs_spend.py::test_learned_threshold_lowers_gate_so_detector_fires -q`
Expected: FAIL — the detector still binds the static `DEFAULT_THRESHOLD_USD`, so the SQL `>= ($2 * 100)` gate stays at $500 and the $450-spend scenario returns `[]` (assertion `len(results) == 1` fails). `test_threshold_defaults_to_500_when_no_override` PASSES already (it asserts current behavior) — that is expected and confirms the safety baseline before the edit.

- [ ] **Step 3: Write the shared `resolve_threshold` helper**

Create `engine/calderyn_engine/detectors/_threshold.py`:

```python
"""Shared threshold resolver for detectors (Plan 05 slice #6).

Wraps :func:`calderyn_engine.thresholds.get_threshold` so a detector can
swap its static dollar constant for the learned, peer-informed value while
preserving its EXACT historical default when the moat is offline.

Why a wrapper instead of calling get_threshold directly: the shared
``_DETECTOR_THRESHOLDS`` registry pins a $500 default for every detector,
but four detectors historically gate at $200. Editing that shared registry
is out of scope for this slice (it is owned by the umbrella). So when
get_threshold returns the *registry default* (i.e. no override row and no
pepper produced a real signal), we substitute the caller's own historical
``fallback`` — guaranteeing zero behavior change offline. When an override
row exists, get_threshold returns a value != the registry default and we
pass it straight through.
"""

from __future__ import annotations

from decimal import Decimal

import asyncpg

from calderyn_engine.thresholds import _DETECTOR_THRESHOLDS, get_threshold


async def resolve_threshold(
    conn: asyncpg.Connection,
    shop_id: str,
    detector_id: str,
    fallback: Decimal,
) -> Decimal:
    """Return the learned dollar threshold, or ``fallback`` when offline.

    ``fallback`` is the detector's own historical module constant. It is
    returned whenever ``get_threshold`` yields the registry default for
    ``detector_id`` (no override row / no pepper), so the detector's
    offline gate is unchanged even where the registry default differs from
    the detector's constant.
    """

    learned = await get_threshold(conn, shop_id, detector_id)
    _key, registry_default = _DETECTOR_THRESHOLDS.get(
        detector_id, ("min_impact_usd", Decimal("0"))
    )
    if learned == registry_default:
        return fallback
    return learned
```

- [ ] **Step 4: Wire the tracer detector**

In `engine/calderyn_engine/detectors/sku_stockout_vs_spend.py`, add the import near the other `calderyn_engine.detectors` import:

```python
from calderyn_engine.detectors._threshold import resolve_threshold
```

Replace the `detect` body (`:120-155`). The threshold is fetched once, bound into the query in place of the static constant, and reused for the severity boundary:

```python
@register(DETECTOR_ID)
async def detect(
    shop_id: str, conn: asyncpg.Connection, now: datetime
) -> list[DetectionResult]:
    """Run the detector and return zero-or-more DetectionResult rows."""

    threshold = await resolve_threshold(
        conn, shop_id, DETECTOR_ID, DEFAULT_THRESHOLD_USD
    )
    rows = await conn.fetch(_QUERY, shop_id, threshold)
    out: list[DetectionResult] = []
    for r in rows:
        spend_dollars = Decimal(r["spend_cents"]) / Decimal("100")
        velocity = Decimal(r["velocity"])
        unit_margin = _unit_margin_dollars(Decimal(r["margin_cents_7d"]), velocity)
        impact = estimate_stockout_loss(
            daily_velocity_units=velocity,
            stockout_days=Decimal("1"),
            unit_margin=unit_margin,
        )
        if impact <= 0:
            # Fall back to wasted spend as a strict lower bound on the loss.
            impact = spend_dollars
        severity = "critical" if spend_dollars >= threshold * 5 else "high"
        out.append(
            DetectionResult(
                detector_id=DETECTOR_ID,
                entity_ref={"sku_id": str(r["sku_id"]), "sku": r["sku_code"]},
                severity=severity,
                dollar_impact=impact,
                evidence={
                    "spend_7d_usd": str(spend_dollars),
                    "sku_title": r["sku_title"],
                    "velocity_units_per_day": str(velocity),
                    "unit_margin_usd": str(unit_margin),
                },
            )
        )
    return out
```

- [ ] **Step 5: Run the tracer tests to verify they pass**

Run: `TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/calderyn_test .venv/bin/python -m pytest tests/engine/unit/test_detector_sku_stockout_vs_spend.py -q`
Expected: PASS (all tests in the file, including the pre-existing three and the two new ones). The `_QUERY` is unchanged — `$2` is still `>= ($2 * 100)`; only the bound value's source changed.

- [ ] **Step 6: Lint the touched files**

Run: `.venv/bin/ruff check engine/calderyn_engine/detectors/_threshold.py engine/calderyn_engine/detectors/sku_stockout_vs_spend.py`
Expected: no output (clean).

- [ ] **Step 7: Commit**

```bash
git add engine/calderyn_engine/detectors/_threshold.py engine/calderyn_engine/detectors/sku_stockout_vs_spend.py tests/engine/unit/test_detector_sku_stockout_vs_spend.py
git commit -m "detectors/sku_stockout_vs_spend: consume learned threshold via get_threshold (tracer)"
```

---

## Task 2: (reserved) — see Task 5 onward

> Tasks are numbered to keep the tracer as Task 1 and the repeat detectors as Tasks 5–13. Tasks 2–4 below cover the cross-detector safety baseline so the repeats can lean on it.

## Task 3: DB-free guard — `resolve_threshold` offline-equivalence unit test

Proves the helper's fallback logic without a database, so the contract is pinned even when the DB-backed tier is skipped (the umbrella's "DB-free tests always run" gate).

**Files:**
- Test: `tests/engine/unit/test_threshold_resolver.py` (create)

**Interfaces:**
- Consumes: `resolve_threshold` (Task 1).

- [ ] **Step 1: Write the failing test**

Create `tests/engine/unit/test_threshold_resolver.py`. Uses a fake connection whose `fetchrow` returns `None` (no override anywhere) so `get_threshold` returns the registry default; the helper must then return the caller's `fallback`.

```python
"""Plan 05 slice #6 — resolve_threshold offline-equivalence (DB-free)."""

from __future__ import annotations

from decimal import Decimal

import pytest

from calderyn_engine.detectors._threshold import resolve_threshold


class _FakeConn:
    """Minimal asyncpg-shaped stub: every fetchrow misses (no override)."""

    async def fetchrow(self, *_args, **_kwargs):
        return None


@pytest.mark.asyncio
async def test_returns_fallback_when_no_override_and_default_is_500(
    monkeypatch,
) -> None:
    monkeypatch.delenv("MOAT_PEPPER", raising=False)
    # registry default for this detector is $500; fallback is also $500.
    value = await resolve_threshold(
        _FakeConn(), "shop-x", "margin_erosion", Decimal("500")
    )
    assert value == Decimal("500")


@pytest.mark.asyncio
async def test_returns_200_fallback_even_though_registry_default_is_500(
    monkeypatch,
) -> None:
    """The Q1 case: registry default is $500 but the detector's historical
    gate is $200. With no override, the helper must return $200, NOT $500."""
    monkeypatch.delenv("MOAT_PEPPER", raising=False)
    value = await resolve_threshold(
        _FakeConn(), "shop-x", "reorder_timing", Decimal("200")
    )
    assert value == Decimal("200")
```

- [ ] **Step 2: Run to verify it passes (helper already exists from Task 1)**

Run: `.venv/bin/python -m pytest tests/engine/unit/test_threshold_resolver.py -q`
Expected: PASS. (No DB needed — `get_threshold` swallows the `fetchrow` path and `_FakeConn.fetchrow` returns `None`, so both layers miss and the registry default is returned, which the helper maps to `fallback`.)

> If this FAILS because `get_threshold`'s `alert_thresholds` query raises on the fake conn rather than returning `None`: the fake's `fetchrow` already returns `None` for every call including the `alert_thresholds` SELECT, so `get_threshold` returns the registry default cleanly. No change needed.

- [ ] **Step 3: Commit**

```bash
git add tests/engine/unit/test_threshold_resolver.py
git commit -m "tests/detectors: DB-free offline-equivalence guard for resolve_threshold"
```

---

## Task 4: Tracer no-fire-at-default regression is in place

Already delivered as `test_threshold_defaults_to_500_when_no_override` in Task 1. No separate work; this task is a checkpoint to confirm the safety test exists and passes before fanning out to the repeats.

- [ ] **Step 1: Confirm**

Run: `TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/calderyn_test .venv/bin/python -m pytest tests/engine/unit/test_detector_sku_stockout_vs_spend.py::test_threshold_defaults_to_500_when_no_override -q`
Expected: PASS.

---

## Repeat task template (Tasks 5–13)

> Each repeat task is self-contained: it shows the **exact** import, the **exact** `detect`-body edit for that detector's shape, and a **no-row safety test** at that detector's correct historical default. Read your task in isolation — the code is repeated, not referenced.

**Two edit shapes:**

- **Shape A (SQL bind):** add the import, fetch the threshold before `conn.fetch`, bind it in place of the static constant. (`regional_spend_starved_stock`.)
- **Shape B (Python post-filter):** add the import, fetch the threshold at the top of `detect`, replace `if impact < DEFAULT_THRESHOLD_USD:` with `if impact < threshold:` (and any severity multiplier). (All others.)

Each repeat ends with: run the file's tests → ruff → commit.

---

## Task 5: `regional_spend_starved_stock` (Shape A — SQL bind)

**Files:**
- Modify: `engine/calderyn_engine/detectors/regional_spend_starved_stock.py:161-167`
- Test: `tests/engine/unit/test_detector_regional_spend_starved_stock.py`

**Interfaces:** Consumes `resolve_threshold` (Task 1). Note this detector's constant is named `DEFAULT_SPEND_THRESHOLD`, not `DEFAULT_THRESHOLD_USD`.

- [ ] **Step 1: Write the failing no-row safety test**

Append to `tests/engine/unit/test_detector_regional_spend_starved_stock.py` (mirror the file's existing fixture usage and `SHOP`/`NOW` constants already defined there):

```python
@pytest.mark.asyncio
async def test_threshold_defaults_to_500_when_no_override(
    pg_pool, seed_shop, seed_regional_starved_scenario, monkeypatch
) -> None:
    """Offline cutover safety: with no MOAT_PEPPER and no override row, the
    regional spend gate stays at the historical $500. Regional spend $400 is
    below $500, so no alert fires."""
    monkeypatch.delenv("MOAT_PEPPER", raising=False)
    await seed_shop(SHOP)
    await seed_regional_starved_scenario(SHOP, regional_spend_usd=Decimal("400"))
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            results = await detect(SHOP, conn, NOW)
    assert results == []
```

> If the file's existing scenario fixture has a different name/parameters than `seed_regional_starved_scenario(SHOP, regional_spend_usd=...)`, read the top of `tests/engine/unit/test_detector_regional_spend_starved_stock.py` and reuse the **exact** fixture and a below-$500 spend value it already exercises. Keep the assertion `results == []`.

- [ ] **Step 2: Run to verify it passes against current code (baseline)**

Run: `TEST_DATABASE_URL=... .venv/bin/python -m pytest tests/engine/unit/test_detector_regional_spend_starved_stock.py::test_threshold_defaults_to_500_when_no_override -q`
Expected: PASS (current code already gates at $500). This locks the offline baseline before the edit; the edit must keep it green.

- [ ] **Step 3: Wire the detector**

Add the import near the existing `from calderyn_engine.detectors import register`:

```python
from calderyn_engine.detectors._threshold import resolve_threshold
```

Edit `detect` (`:161-167`) — fetch the threshold and bind it in place of `DEFAULT_SPEND_THRESHOLD`:

```python
@register(DETECTOR_ID)
async def detect(
    shop_id: str, conn: asyncpg.Connection, now: datetime
) -> list[DetectionResult]:
    """Run the detector and return zero-or-more DetectionResult rows."""

    threshold = await resolve_threshold(
        conn, shop_id, DETECTOR_ID, DEFAULT_SPEND_THRESHOLD
    )
    rows = await conn.fetch(_QUERY, shop_id, threshold)
```

Leave the rest of the body unchanged (the `for r in rows:` loop is untouched).

- [ ] **Step 4: Run the file's full test suite**

Run: `TEST_DATABASE_URL=... .venv/bin/python -m pytest tests/engine/unit/test_detector_regional_spend_starved_stock.py -q`
Expected: PASS (all tests, including the new safety test).

- [ ] **Step 5: Lint**

Run: `.venv/bin/ruff check engine/calderyn_engine/detectors/regional_spend_starved_stock.py`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add engine/calderyn_engine/detectors/regional_spend_starved_stock.py tests/engine/unit/test_detector_regional_spend_starved_stock.py
git commit -m "detectors/regional_spend_starved_stock: consume learned threshold via get_threshold"
```

---

## Task 6: `campaign_below_breakeven` (Shape B — post-filter + severity ×4)

**Files:**
- Modify: `engine/calderyn_engine/detectors/campaign_below_breakeven.py:76-96`
- Test: `tests/engine/unit/test_detector_campaign_below_breakeven.py`

- [ ] **Step 1: Write the failing no-row safety test**

Append to `tests/engine/unit/test_detector_campaign_below_breakeven.py` (reuses `SHOP`, `NOW`, `seed_breakeven_scenario` already in the file):

```python
@pytest.mark.asyncio
async def test_threshold_defaults_to_500_when_no_override(
    pg_pool, seed_shop, seed_breakeven_scenario, monkeypatch
) -> None:
    """Offline cutover safety: no MOAT_PEPPER, no override → $500 gate.
    Loss $200 (spend $300, gp $100) is below $500 ⇒ no fire."""
    monkeypatch.delenv("MOAT_PEPPER", raising=False)
    await seed_shop(SHOP)
    await seed_breakeven_scenario(
        SHOP,
        spend=Decimal("300"),
        revenue=Decimal("200"),
        cogs=Decimal("100"),
    )
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            results = await detect(SHOP, conn, NOW)
    assert results == []
```

- [ ] **Step 2: Run to verify it passes against current code (baseline)**

Run: `TEST_DATABASE_URL=... .venv/bin/python -m pytest tests/engine/unit/test_detector_campaign_below_breakeven.py::test_threshold_defaults_to_500_when_no_override -q`
Expected: PASS (current code gates at $500). Baseline locked.

- [ ] **Step 3: Wire the detector**

Add the import:

```python
from calderyn_engine.detectors._threshold import resolve_threshold
```

Edit `detect` (`:76-96`). Fetch the threshold once; use it for the gate AND the severity boundary (replacing both reads of `DEFAULT_THRESHOLD_USD`):

```python
@register(DETECTOR_ID)
async def detect(
    shop_id: str, conn: asyncpg.Connection, now: datetime
) -> list[DetectionResult]:
    """Run the detector and return zero-or-more DetectionResult rows."""

    threshold = await resolve_threshold(
        conn, shop_id, DETECTOR_ID, DEFAULT_THRESHOLD_USD
    )
    rows = await conn.fetch(_QUERY, shop_id)
    out: list[DetectionResult] = []
    for r in rows:
        spend = Decimal(r["spend_cents"]) / Decimal("100")
        revenue = Decimal(r["revenue_cents"]) / Decimal("100")
        cogs = Decimal(r["cogs_cents"]) / Decimal("100")
        gross_profit = revenue - cogs
        impact = estimate_below_breakeven_loss(
            spend=spend, gross_profit=gross_profit
        )
        if impact < threshold:
            continue
        severity = (
            "critical" if impact >= threshold * 4 else "high"
        )
        out.append(
            DetectionResult(
                detector_id=DETECTOR_ID,
                entity_ref={
                    "campaign_id": str(r["campaign_id"]),
                    "platform": r["platform"],
                },
                severity=severity,
                dollar_impact=impact,
                evidence={
                    "campaign_name": r["campaign_name"],
                    "spend_7d_usd": str(spend),
                    "revenue_7d_usd": str(revenue),
                    "cogs_7d_usd": str(cogs),
                    "gross_profit_7d_usd": str(gross_profit),
                },
            )
        )
    return out
```

- [ ] **Step 4: Run the file's full test suite**

Run: `TEST_DATABASE_URL=... .venv/bin/python -m pytest tests/engine/unit/test_detector_campaign_below_breakeven.py -q`
Expected: PASS. (`test_threshold_constant_is_500_usd` still passes — we did not delete `DEFAULT_THRESHOLD_USD`. The `@pytest.mark.skip`-marked fire test stays skipped.)

- [ ] **Step 5: Lint**

Run: `.venv/bin/ruff check engine/calderyn_engine/detectors/campaign_below_breakeven.py`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add engine/calderyn_engine/detectors/campaign_below_breakeven.py tests/engine/unit/test_detector_campaign_below_breakeven.py
git commit -m "detectors/campaign_below_breakeven: consume learned threshold via get_threshold"
```

---

## Task 7: `margin_erosion` (Shape B — post-filter, $500)

**Files:**
- Modify: `engine/calderyn_engine/detectors/margin_erosion.py:75-101`
- Test: `tests/engine/unit/test_detector_margin_erosion.py`

- [ ] **Step 1: Write the failing no-row safety test**

Append to `tests/engine/unit/test_detector_margin_erosion.py`. Read the top of that file first and reuse its existing `SHOP`, `NOW`, and scenario fixture exactly. The safety test seeds an erosion scenario whose `impact` is **between $0 and $500** (so it fires under a lowered learned gate but NOT under the $500 default) and asserts `results == []` offline:

```python
@pytest.mark.asyncio
async def test_threshold_defaults_to_500_when_no_override(
    pg_pool, seed_shop, seed_margin_erosion_scenario, monkeypatch
) -> None:
    """Offline cutover safety: no MOAT_PEPPER, no override → $500 gate.
    A scenario with implied loss < $500 must not fire."""
    monkeypatch.delenv("MOAT_PEPPER", raising=False)
    await seed_shop(SHOP)
    # Use the fixture's parameters that produce a sub-$500 dollar impact.
    await seed_margin_erosion_scenario(SHOP, impact_usd=Decimal("300"))
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            results = await detect(SHOP, conn, NOW)
    assert results == []
```

> Adapt the fixture name/params to what `tests/engine/unit/test_detector_margin_erosion.py` already uses. If no parameterized scenario fixture exists, replicate the file's existing "does not fire below threshold" seed values (they already produce a sub-$500 impact) and keep the `results == []` assertion. The point is: a below-$500 input stays non-firing offline.

- [ ] **Step 2: Run to verify it passes against current code (baseline)**

Run: `TEST_DATABASE_URL=... .venv/bin/python -m pytest tests/engine/unit/test_detector_margin_erosion.py::test_threshold_defaults_to_500_when_no_override -q`
Expected: PASS.

- [ ] **Step 3: Wire the detector**

Add the import:

```python
from calderyn_engine.detectors._threshold import resolve_threshold
```

Edit `detect` (`:75-101`) — fetch threshold at top, swap the gate:

```python
@register(DETECTOR_ID)
async def detect(
    shop_id: str, conn: asyncpg.Connection, now: datetime
) -> list[DetectionResult]:
    threshold = await resolve_threshold(
        conn, shop_id, DETECTOR_ID, DEFAULT_THRESHOLD_USD
    )
    rows = await conn.fetch(_QUERY, shop_id, MIN_BASELINE_UNITS)
    out: list[DetectionResult] = []
    for r in rows:
        baseline_margin_cents = Decimal(r["baseline_price_cents"] or 0) - Decimal(
            r["baseline_cost_cents"] or 0
        )
        current_margin_cents = Decimal(r["current_price_cents"] or 0) - Decimal(
            r["current_cost_cents"] or 0
        )
        if baseline_margin_cents <= 0:
            continue
        delta = baseline_margin_cents - current_margin_cents
        drop_pct = delta / baseline_margin_cents
        if drop_pct < MIN_DROP_PCT:
            continue
        baseline_margin = baseline_margin_cents / Decimal(100)
        current_margin = current_margin_cents / Decimal(100)
        impact = estimate_margin_erosion_loss(
            units_sold=Decimal(r["current_units"]),
            baseline_unit_margin=baseline_margin,
            current_unit_margin=current_margin,
        )
        if impact < threshold:
            continue
```

Leave everything after the gate (the `out.append(...)` block and `return out`) unchanged.

- [ ] **Step 4: Run the file's full test suite**

Run: `TEST_DATABASE_URL=... .venv/bin/python -m pytest tests/engine/unit/test_detector_margin_erosion.py -q`
Expected: PASS.

- [ ] **Step 5: Lint**

Run: `.venv/bin/ruff check engine/calderyn_engine/detectors/margin_erosion.py`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add engine/calderyn_engine/detectors/margin_erosion.py tests/engine/unit/test_detector_margin_erosion.py
git commit -m "detectors/margin_erosion: consume learned threshold via get_threshold"
```

---

## Task 8: `cogs_drift` (Shape B — post-filter, $500)

**Files:**
- Modify: `engine/calderyn_engine/detectors/cogs_drift.py:64-77`
- Test: `tests/engine/unit/test_detector_cogs_drift.py`

- [ ] **Step 1: Write the failing no-row safety test**

Append to `tests/engine/unit/test_detector_cogs_drift.py`, reusing the file's `SHOP`/`NOW`/scenario fixture. Seed a drift scenario whose 30-day dollar exposure is below $500 and assert no fire offline:

```python
@pytest.mark.asyncio
async def test_threshold_defaults_to_500_when_no_override(
    pg_pool, seed_shop, seed_cogs_drift_scenario, monkeypatch
) -> None:
    monkeypatch.delenv("MOAT_PEPPER", raising=False)
    await seed_shop(SHOP)
    await seed_cogs_drift_scenario(SHOP, exposure_usd=Decimal("300"))
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            results = await detect(SHOP, conn, NOW)
    assert results == []
```

> Match the existing fixture name/params in the file; reuse its below-threshold seed if no parameterized variant exists. Keep `results == []`.

- [ ] **Step 2: Run to verify it passes against current code (baseline)**

Run: `TEST_DATABASE_URL=... .venv/bin/python -m pytest tests/engine/unit/test_detector_cogs_drift.py::test_threshold_defaults_to_500_when_no_override -q`
Expected: PASS.

- [ ] **Step 3: Wire the detector**

Add the import:

```python
from calderyn_engine.detectors._threshold import resolve_threshold
```

Edit `detect` (`:64-77`):

```python
@register(DETECTOR_ID)
async def detect(
    shop_id: str, conn: asyncpg.Connection, now: datetime
) -> list[DetectionResult]:
    threshold = await resolve_threshold(
        conn, shop_id, DETECTOR_ID, DEFAULT_THRESHOLD_USD
    )
    rows = await conn.fetch(_QUERY, shop_id, MIN_DRIFT_PCT)
    out: list[DetectionResult] = []
    for r in rows:
        current_cents = Decimal(r["current_cost_cents"])
        prior_cents = Decimal(r["prior_cost_cents"])
        units = Decimal(r["units_30d"] or 0)
        delta_cents = current_cents - prior_cents
        impact = (delta_cents * units / Decimal(100)).quantize(Decimal("0.01"))
        if impact < threshold:
            continue
```

Leave the rest of the loop and `return out` unchanged.

- [ ] **Step 4: Run the file's full test suite**

Run: `TEST_DATABASE_URL=... .venv/bin/python -m pytest tests/engine/unit/test_detector_cogs_drift.py -q`
Expected: PASS.

- [ ] **Step 5: Lint**

Run: `.venv/bin/ruff check engine/calderyn_engine/detectors/cogs_drift.py`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add engine/calderyn_engine/detectors/cogs_drift.py tests/engine/unit/test_detector_cogs_drift.py
git commit -m "detectors/cogs_drift: consume learned threshold via get_threshold"
```

---

## Task 9: `negative_unit_economics` (Shape B — post-filter, $500)

**Files:**
- Modify: `engine/calderyn_engine/detectors/negative_unit_economics.py:96-118`
- Test: `tests/engine/unit/test_detector_negative_unit_economics.py`

- [ ] **Step 1: Write the failing no-row safety test**

Append to `tests/engine/unit/test_detector_negative_unit_economics.py`, reusing its `SHOP`/`NOW`/scenario fixture. Seed a negative-economics scenario whose dollar impact is below $500 and assert no offline fire:

```python
@pytest.mark.asyncio
async def test_threshold_defaults_to_500_when_no_override(
    pg_pool, seed_shop, seed_negative_unit_economics_scenario, monkeypatch
) -> None:
    monkeypatch.delenv("MOAT_PEPPER", raising=False)
    await seed_shop(SHOP)
    await seed_negative_unit_economics_scenario(SHOP, impact_usd=Decimal("300"))
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            results = await detect(SHOP, conn, NOW)
    assert results == []
```

> Match the existing fixture name/params; reuse the file's below-threshold seed if needed. Keep `results == []`.

- [ ] **Step 2: Run to verify it passes against current code (baseline)**

Run: `TEST_DATABASE_URL=... .venv/bin/python -m pytest tests/engine/unit/test_detector_negative_unit_economics.py::test_threshold_defaults_to_500_when_no_override -q`
Expected: PASS.

- [ ] **Step 3: Wire the detector**

Add the import:

```python
from calderyn_engine.detectors._threshold import resolve_threshold
```

Edit `detect` (`:96-118`):

```python
@register(DETECTOR_ID)
async def detect(
    shop_id: str, conn: asyncpg.Connection, now: datetime
) -> list[DetectionResult]:
    threshold = await resolve_threshold(
        conn, shop_id, DETECTOR_ID, DEFAULT_THRESHOLD_USD
    )
    rows = await conn.fetch(_QUERY, shop_id)
    out: list[DetectionResult] = []
    for r in rows:
        unit_margin_cents = Decimal(r["unit_margin_cents"] or 0)
        spend_cents = Decimal(r["attributed_spend_cents"] or 0)
        attrib_units = Decimal(r["attributed_units"] or 0)
        units_14d = Decimal(r["units_14d"] or 0)
        if attrib_units <= 0 or units_14d <= 0:
            continue
        cac_per_unit_cents = spend_cents / attrib_units
        net_per_unit_cents = unit_margin_cents - cac_per_unit_cents
        if net_per_unit_cents >= 0:
            continue
        net_per_unit_dollars = net_per_unit_cents / Decimal(100)
        impact = (abs(net_per_unit_dollars) * units_14d).quantize(
            Decimal("0.01")
        )
        if impact < threshold:
            continue
```

Leave the rest of the loop and `return out` unchanged.

- [ ] **Step 4: Run the file's full test suite**

Run: `TEST_DATABASE_URL=... .venv/bin/python -m pytest tests/engine/unit/test_detector_negative_unit_economics.py -q`
Expected: PASS.

- [ ] **Step 5: Lint**

Run: `.venv/bin/ruff check engine/calderyn_engine/detectors/negative_unit_economics.py`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add engine/calderyn_engine/detectors/negative_unit_economics.py tests/engine/unit/test_detector_negative_unit_economics.py
git commit -m "detectors/negative_unit_economics: consume learned threshold via get_threshold"
```

---

## Task 10: `return_rate_hidden_loss` (Shape B — post-filter, **$200** ⚠)

> ⚠ Historical default is **$200**, but `_DETECTOR_THRESHOLDS` registers $500. `resolve_threshold` returns the `$200` fallback when offline (because `get_threshold` yields the $500 registry default, which the helper maps to `fallback`). The safety test below proves the gate stays at $200.

**Files:**
- Modify: `engine/calderyn_engine/detectors/return_rate_hidden_loss.py:68-94`
- Test: `tests/engine/unit/test_detector_return_rate_hidden_loss.py`

- [ ] **Step 1: Write the failing no-row safety test**

Append, reusing the file's `SHOP`/`NOW`/scenario fixture. Critically, seed a scenario whose impact is **between $200 and $500** so it MUST fire offline at the $200 gate (this is the test that would catch a regression to $500):

```python
@pytest.mark.asyncio
async def test_threshold_defaults_to_200_when_no_override(
    pg_pool, seed_shop, seed_return_rate_scenario, monkeypatch
) -> None:
    """Cutover safety for a $200-default detector: with no override, the gate
    is the historical $200 — NOT the $500 registry default. A scenario whose
    write-off is $350 (between $200 and $500) MUST still fire offline."""
    monkeypatch.delenv("MOAT_PEPPER", raising=False)
    await seed_shop(SHOP)
    await seed_return_rate_scenario(SHOP, writeoff_usd=Decimal("350"))
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            results = await detect(SHOP, conn, NOW)
    assert len(results) == 1
```

> Match the existing fixture name/params in `tests/engine/unit/test_detector_return_rate_hidden_loss.py`. Pick seed values the fixture already supports that yield a $200–$500 implied loss. The assertion MUST be `len(results) == 1` (fires) — that is what distinguishes $200 from a buggy $500.

- [ ] **Step 2: Run to verify it passes against current code (baseline)**

Run: `TEST_DATABASE_URL=... .venv/bin/python -m pytest tests/engine/unit/test_detector_return_rate_hidden_loss.py::test_threshold_defaults_to_200_when_no_override -q`
Expected: PASS (current code gates at $200, so a $350 write-off fires). This baseline is exactly what the edit must preserve.

- [ ] **Step 3: Wire the detector**

Add the import:

```python
from calderyn_engine.detectors._threshold import resolve_threshold
```

Edit `detect` (`:68-94`) — pass the detector's own `DEFAULT_THRESHOLD_USD` (== $200) as the fallback:

```python
@register(DETECTOR_ID)
async def detect(
    shop_id: str, conn: asyncpg.Connection, now: datetime
) -> list[DetectionResult]:
    threshold = await resolve_threshold(
        conn, shop_id, DETECTOR_ID, DEFAULT_THRESHOLD_USD
    )
    rows = await conn.fetch(_QUERY, shop_id, MIN_REVENUE_CENTS)
    out: list[DetectionResult] = []
    for r in rows:
        revenue = Decimal(r["revenue_cents"])
        returns = Decimal(r["return_cents"] or 0)
        if revenue <= 0:
            continue
        rate = returns / revenue
        if rate < (BASELINE_RETURN_RATE + FLAG_MARGIN):
            continue
        avg_price_cents = Decimal(r["avg_price_cents"] or 0)
        avg_cost_cents = Decimal(r["avg_unit_cost_cents"] or 0)
        if avg_price_cents <= 0:
            continue
        returned_units = returns / avg_price_cents
        unit_cost_dollars = avg_cost_cents / Decimal(100)
        impact = estimate_return_loss(
            returned_units=returned_units,
            unit_cost=unit_cost_dollars,
        )
        if impact < threshold:
            continue
```

Leave the rest of the loop and `return out` unchanged.

- [ ] **Step 4: Run the file's full test suite**

Run: `TEST_DATABASE_URL=... .venv/bin/python -m pytest tests/engine/unit/test_detector_return_rate_hidden_loss.py -q`
Expected: PASS — including the new test asserting it still fires at $350 (gate held at $200).

- [ ] **Step 5: Lint**

Run: `.venv/bin/ruff check engine/calderyn_engine/detectors/return_rate_hidden_loss.py`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add engine/calderyn_engine/detectors/return_rate_hidden_loss.py tests/engine/unit/test_detector_return_rate_hidden_loss.py
git commit -m "detectors/return_rate_hidden_loss: consume learned threshold via get_threshold (preserve $200 default)"
```

---

## Task 11: `reorder_timing` (Shape B — post-filter, **$200** ⚠)

**Files:**
- Modify: `engine/calderyn_engine/detectors/reorder_timing.py:78-101`
- Test: `tests/engine/unit/test_detector_reorder_timing.py`

- [ ] **Step 1: Write the failing no-row safety test**

Append, reusing the file's `SHOP`/`NOW`/scenario fixture. Seed an impact between $200 and $500 so it MUST fire at the $200 gate offline:

```python
@pytest.mark.asyncio
async def test_threshold_defaults_to_200_when_no_override(
    pg_pool, seed_shop, seed_reorder_timing_scenario, monkeypatch
) -> None:
    """$200-default detector: offline gate is $200, not the $500 registry
    default. A $350 stockout-exposure scenario must fire offline."""
    monkeypatch.delenv("MOAT_PEPPER", raising=False)
    await seed_shop(SHOP)
    await seed_reorder_timing_scenario(SHOP, impact_usd=Decimal("350"))
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            results = await detect(SHOP, conn, NOW)
    assert len(results) == 1
```

> Match the file's actual fixture name/params and a $200–$500 impact seed; assertion `len(results) == 1`.

- [ ] **Step 2: Run to verify it passes against current code (baseline)**

Run: `TEST_DATABASE_URL=... .venv/bin/python -m pytest tests/engine/unit/test_detector_reorder_timing.py::test_threshold_defaults_to_200_when_no_override -q`
Expected: PASS.

- [ ] **Step 3: Wire the detector**

Add the import:

```python
from calderyn_engine.detectors._threshold import resolve_threshold
```

Edit `detect` (`:78-101`):

```python
@register(DETECTOR_ID)
async def detect(
    shop_id: str, conn: asyncpg.Connection, now: datetime
) -> list[DetectionResult]:
    threshold = await resolve_threshold(
        conn, shop_id, DETECTOR_ID, DEFAULT_THRESHOLD_USD
    )
    rows = await conn.fetch(_QUERY, shop_id)
    out: list[DetectionResult] = []
    for r in rows:
        days_of_cover = Decimal(r["days_of_cover"])
        units_window7 = Decimal(r["units_window7"] or 0)
        velocity = units_window7 / Decimal("7")
        if velocity < MIN_VELOCITY:
            continue
        if days_of_cover >= DEFAULT_LEAD_TIME_DAYS:
            continue
        gap_days = DEFAULT_LEAD_TIME_DAYS - days_of_cover
        unit_margin_cents = Decimal(r["unit_margin_cents"] or 0)
        unit_margin_dollars = unit_margin_cents / Decimal(100)
        impact = estimate_stockout_loss(
            daily_velocity_units=velocity,
            stockout_days=gap_days,
            unit_margin=unit_margin_dollars,
        )
        if impact < threshold:
            continue
```

Leave the rest of the loop and `return out` unchanged.

- [ ] **Step 4: Run the file's full test suite**

Run: `TEST_DATABASE_URL=... .venv/bin/python -m pytest tests/engine/unit/test_detector_reorder_timing.py -q`
Expected: PASS.

- [ ] **Step 5: Lint**

Run: `.venv/bin/ruff check engine/calderyn_engine/detectors/reorder_timing.py`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add engine/calderyn_engine/detectors/reorder_timing.py tests/engine/unit/test_detector_reorder_timing.py
git commit -m "detectors/reorder_timing: consume learned threshold via get_threshold (preserve $200 default)"
```

---

## Task 12: `wrong_location_concentration` (Shape B — post-filter, **$200** ⚠)

**Files:**
- Modify: `engine/calderyn_engine/detectors/wrong_location_concentration.py:94-111`
- Test: `tests/engine/unit/test_detector_wrong_location_concentration.py`

- [ ] **Step 1: Write the failing no-row safety test**

Append, reusing the file's `SHOP`/`NOW`/scenario fixture. Seed a carrying-cost impact between $200 and $500 so it fires at $200 offline:

```python
@pytest.mark.asyncio
async def test_threshold_defaults_to_200_when_no_override(
    pg_pool, seed_shop, seed_wrong_location_scenario, monkeypatch
) -> None:
    """$200-default detector: offline gate is $200, not the $500 registry
    default. A $350-impact concentration scenario must fire offline."""
    monkeypatch.delenv("MOAT_PEPPER", raising=False)
    await seed_shop(SHOP)
    await seed_wrong_location_scenario(SHOP, impact_usd=Decimal("350"))
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            results = await detect(SHOP, conn, NOW)
    assert len(results) == 1
```

> Match the file's actual fixture name/params and a $200–$500 impact seed; assertion `len(results) == 1`.

- [ ] **Step 2: Run to verify it passes against current code (baseline)**

Run: `TEST_DATABASE_URL=... .venv/bin/python -m pytest tests/engine/unit/test_detector_wrong_location_concentration.py::test_threshold_defaults_to_200_when_no_override -q`
Expected: PASS.

- [ ] **Step 3: Wire the detector**

Add the import:

```python
from calderyn_engine.detectors._threshold import resolve_threshold
```

Edit `detect` (`:94-111`):

```python
@register(DETECTOR_ID)
async def detect(
    shop_id: str, conn: asyncpg.Connection, now: datetime
) -> list[DetectionResult]:
    threshold = await resolve_threshold(
        conn, shop_id, DETECTOR_ID, DEFAULT_THRESHOLD_USD
    )
    rows = await conn.fetch(
        _QUERY, shop_id, STOCK_CONCENTRATION, DEMAND_SHARE_THRESHOLD
    )
    out: list[DetectionResult] = []
    for r in rows:
        qty = Decimal(r["qty"] or 0)
        unit_margin_cents = Decimal(r["unit_margin_cents"] or 0)
        unit_margin_dollars = unit_margin_cents / Decimal(100)
        # Carrying cost proxy: 10% of the locked margin held at the wrong loc.
        impact = (qty * unit_margin_dollars * Decimal("0.1")).quantize(
            Decimal("0.01")
        )
        if impact < threshold:
            continue
```

Leave the rest of the loop and `return out` unchanged.

- [ ] **Step 4: Run the file's full test suite**

Run: `TEST_DATABASE_URL=... .venv/bin/python -m pytest tests/engine/unit/test_detector_wrong_location_concentration.py -q`
Expected: PASS.

- [ ] **Step 5: Lint**

Run: `.venv/bin/ruff check engine/calderyn_engine/detectors/wrong_location_concentration.py`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add engine/calderyn_engine/detectors/wrong_location_concentration.py tests/engine/unit/test_detector_wrong_location_concentration.py
git commit -m "detectors/wrong_location_concentration: consume learned threshold via get_threshold (preserve $200 default)"
```

---

## Task 13: `regional_shortage_risk` (Shape B — post-filter, **$200** ⚠)

**Files:**
- Modify: `engine/calderyn_engine/detectors/regional_shortage_risk.py:80-104`
- Test: `tests/engine/unit/test_detector_regional_shortage_risk.py`

- [ ] **Step 1: Write the failing no-row safety test**

Append, reusing the file's `SHOP`/`NOW`/scenario fixture. Seed an impact between $200 and $500 so it fires at $200 offline:

```python
@pytest.mark.asyncio
async def test_threshold_defaults_to_200_when_no_override(
    pg_pool, seed_shop, seed_regional_shortage_scenario, monkeypatch
) -> None:
    """$200-default detector: offline gate is $200, not the $500 registry
    default. A $350-impact regional-shortage scenario must fire offline."""
    monkeypatch.delenv("MOAT_PEPPER", raising=False)
    await seed_shop(SHOP)
    await seed_regional_shortage_scenario(SHOP, impact_usd=Decimal("350"))
    async with pg_pool.acquire() as conn:
        async with with_shop_context(conn, SHOP):
            results = await detect(SHOP, conn, NOW)
    assert len(results) == 1
```

> Match the file's actual fixture name/params and a $200–$500 impact seed; assertion `len(results) == 1`.

- [ ] **Step 2: Run to verify it passes against current code (baseline)**

Run: `TEST_DATABASE_URL=... .venv/bin/python -m pytest tests/engine/unit/test_detector_regional_shortage_risk.py::test_threshold_defaults_to_200_when_no_override -q`
Expected: PASS.

- [ ] **Step 3: Wire the detector**

Add the import:

```python
from calderyn_engine.detectors._threshold import resolve_threshold
```

Edit `detect` (`:80-104`):

```python
@register(DETECTOR_ID)
async def detect(
    shop_id: str, conn: asyncpg.Connection, now: datetime
) -> list[DetectionResult]:
    threshold = await resolve_threshold(
        conn, shop_id, DETECTOR_ID, DEFAULT_THRESHOLD_USD
    )
    rows = await conn.fetch(_QUERY, shop_id, DEFAULT_LEAD_TIME_DAYS)
    out: list[DetectionResult] = []
    for r in rows:
        daily_demand = Decimal(r["daily_demand"] or 0)
        stock = Decimal(r["stock"] or 0)
        if daily_demand <= 0:
            continue
        projected_need = daily_demand * DEFAULT_LEAD_TIME_DAYS
        shortfall_units = projected_need - stock
        if shortfall_units <= 0:
            continue
        shortfall_days = shortfall_units / daily_demand
        unit_margin_cents = Decimal(r["unit_margin_cents"] or 0)
        unit_margin_dollars = unit_margin_cents / Decimal(100)
        impact = estimate_stockout_loss(
            daily_velocity_units=daily_demand,
            stockout_days=shortfall_days,
            unit_margin=unit_margin_dollars,
        )
        if impact < threshold:
            continue
```

Leave the rest of the loop and `return out` unchanged.

- [ ] **Step 4: Run the file's full test suite**

Run: `TEST_DATABASE_URL=... .venv/bin/python -m pytest tests/engine/unit/test_detector_regional_shortage_risk.py -q`
Expected: PASS.

- [ ] **Step 5: Lint**

Run: `.venv/bin/ruff check engine/calderyn_engine/detectors/regional_shortage_risk.py`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add engine/calderyn_engine/detectors/regional_shortage_risk.py tests/engine/unit/test_detector_regional_shortage_risk.py
git commit -m "detectors/regional_shortage_risk: consume learned threshold via get_threshold (preserve $200 default)"
```

---

## Task 14: Full-suite green + Shape-C no-op verification

Confirms all 10 threaded detectors pass together, the 2 Shape-C detectors are untouched, and the pipeline still runs.

**Files:** none modified (verification only).

- [ ] **Step 1: Confirm Shape-C detectors are unchanged**

Run: `git diff --name-only engine/calderyn_engine/detectors/ad_tax_overload.py engine/calderyn_engine/detectors/scaling_sku_fulfillment_risk.py`
Expected: no output (both files untouched).

- [ ] **Step 2: Run the full engine detector + threshold suite (DB-backed)**

Run: `TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/calderyn_test .venv/bin/python -m pytest tests/engine/unit/test_detector_*.py tests/engine/unit/test_threshold_resolver.py tests/engine/integration/test_thresholds.py tests/engine/integration/test_pipeline_end_to_end.py -q`
Expected: PASS (no new failures vs. the pre-slice baseline; the pre-existing `@pytest.mark.skip` on `test_fires_when_spend_exceeds_gross_profit` stays skipped).

- [ ] **Step 3: Run the DB-free tier to confirm nothing regressed without a DB**

Run: `.venv/bin/python -m pytest tests/engine -q`
Expected: PASS (DB-backed tests skip cleanly; `test_threshold_resolver.py` and all golden-fixture tests pass).

- [ ] **Step 4: Lint the whole detectors package**

Run: `.venv/bin/ruff check engine/calderyn_engine/detectors/`
Expected: clean.

- [ ] **Step 5: Final commit (if any verification fixups were needed)**

```bash
git add -A engine/calderyn_engine/detectors tests/engine
git commit -m "detectors: verify learned-threshold cutover across all threaded detectors"
```

---

## Self-Review notes (carried for the implementer)

- **Spec coverage:** Tasks 1, 5–13 thread the 10 dollar-gated detectors; Task 14 verifies the 2 Shape-C no-ops. Helper (Task 1) + DB-free guard (Task 3) cover the Q1 `$200`-default resolution.
- **Q1 resolution lives in ONE place** (`resolve_threshold`); if the orchestrator instead edits `_DETECTOR_THRESHOLDS` to the correct $200 values, the helper's `if learned == registry_default: return fallback` becomes a no-op and the four `$200` tasks still pass unchanged — the conditional simply never triggers because registry_default would equal the $200 fallback. Forward-compatible either way.
- **Type consistency:** every detector calls `resolve_threshold(conn, shop_id, DETECTOR_ID, <its own constant>)` and uses the returned `Decimal` named `threshold`. `sku_stockout_vs_spend` and `campaign_below_breakeven` additionally use `threshold` in their severity multipliers; no other detector has a second use.
- **No placeholders:** every wired `detect` body is shown in full down to its gate; the unchanged tail (`out.append(...)` / `return out`) is explicitly called out as "leave unchanged" so the implementer does not re-type or accidentally alter it.
- **Fixture-name caveat:** the per-detector safety tests reference scenario fixtures by their likely names. Each task instructs the implementer to read the test file's existing fixtures and reuse the EXACT name + a seed value in the right impact band. This is the one place names cannot be pinned from `thresholds.py` alone; the assertion (`results == []` for $500 detectors, `len(results) == 1` for $200 detectors) is the load-bearing, fixture-agnostic invariant.
