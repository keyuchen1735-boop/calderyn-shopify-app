# Moat Peer + Incident ETL (Slice #5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the nightly cross-tenant ETL orchestrator that projects the day's consenting `public.alerts` into pseudonymized `moat.event_log` rows, rolls them into per-`(detector, GMV-band)` `moat.peer_baselines` under a k≥5 floor, and harvests confirmed losses into `moat.incident_library`.

**Architecture:** One new module `engine/calderyn_engine/moat/peer_incident_etl.py` holding (a) a pure segment function `segment_for_shop`, (b) a pseudonymized projection driver that reuses `emit_moat_event`, (c) an additive segment-aware baseline aggregate `compute_peer_baselines_by_segment` that mirrors the fixed `compute_peer_baselines` SQL + `K_FLOOR` + upsert but filters by `payload->>'segment'`, (d) an incident driver that reuses `extract_incident`, and (e) the orchestrator `run_peer_incident_etl` returning an `EtlReport`. The fixed kernels are NOT modified; #5 only adds code. The orchestrator never opens a transaction (caller owns scope) and never reads env (caller passes `pepper`).

**Tech Stack:** Python 3.12, asyncpg, structlog, pydantic v2 (via the existing `PAYLOAD_MODELS`), pytest + pytest-asyncio. DB tests run against a local Postgres via `tests/engine/scripts/test-db.sh up` with `TEST_DATABASE_URL` set; they skip otherwise.

## Global Constraints

- **Do not modify the fixed kernels** (`emitter.py`, `peer_baselines.py`, `incident_extractor.py`, `pseudonym.py`, `consent_purge.py`, `events.py`). This slice is additive only.
- **k-floor = 5** distinct contributors per `(segment, detector)`; suppress (write no row) below it. Re-export `K_FLOOR` from `peer_baselines.py` — single source of truth.
- **Consent gate (A2):** only `shops.peer_data_consent = true` shops contribute to projection, baselines, or incidents.
- **Pseudonyms only (A1):** never write `shop_id` into any `moat.*` table; pseudonym derivation is `pseudonym_for(shop_id, pepper)` (`"p_" + hex(HMAC_SHA256(pepper, shop_id))[:32]`).
- **Segment = `"gmv:<band>"`**, `band ∈ {micro, small, mid, large, xl}`, from trailing-90-day `sum(order_fact.total_cents)`; thresholds (USD): micro `<10_000`, small `[10_000,50_000)`, mid `[50_000,250_000)`, large `[250_000,1_000_000)`, xl `≥1_000_000`. Zero orders → micro.
- **No transaction management in #5** — `conn` is caller-scoped ("this function does not BEGIN/COMMIT"). **No env reads** — `pepper` is a parameter.
- **Projected `detection_fired` payload** = `{alert_id, severity, detector_id, dollar_impact, thresholds_used, day_bucket, segment}`. `dollar_impact` is the field baselines aggregate; `segment` enables per-band filtering; `day_bucket` enables idempotency.
- **Idempotency:** delete-then-reproject keyed on `(payload->>'day_bucket')::date = run_date` for `event_kind='detection_fired'`, inside the caller's single transaction.
- Async tests use the explicit `@pytest.mark.asyncio` marker (match the existing moat suite — not auto mode). DB tests use the `pg_pool` fixture and skip without a local `TEST_DATABASE_URL`.
- Run target (CI parity): `uv run pytest tests/engine -q`. Local single-file: `TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/calderyn_test uv run pytest tests/engine/moat/test_peer_incident_etl.py -v`.

---

### Task 1: Segment function `segment_for_shop`

**Files:**
- Create: `engine/calderyn_engine/moat/peer_incident_etl.py`
- Test: `tests/engine/moat/test_peer_incident_etl.py`

**Interfaces:**
- Consumes: nothing (pure function).
- Produces: `segment_for_shop(gmv_90d_cents: int) -> str` returning `"gmv:<band>"`; module constant `GMV_BANDS`. Later tasks call this to label projected rows and to enumerate bands.

- [ ] **Step 1: Write the failing test**

```python
"""Slice #5 — peer + incident ETL tests. DB-backed tests use the parent
pg_pool fixture and skip unless TEST_DATABASE_URL points at a local pg."""

from __future__ import annotations

import json
import uuid
from datetime import date, timedelta
from decimal import Decimal

import pytest

from calderyn_engine.moat.peer_incident_etl import segment_for_shop


def test_segment_for_shop_band_thresholds():
    assert segment_for_shop(0) == "gmv:micro"
    assert segment_for_shop(9_999_99) == "gmv:micro"          # $9,999.99
    assert segment_for_shop(10_000_00) == "gmv:small"         # $10,000.00
    assert segment_for_shop(49_999_99) == "gmv:small"
    assert segment_for_shop(50_000_00) == "gmv:mid"
    assert segment_for_shop(249_999_99) == "gmv:mid"
    assert segment_for_shop(250_000_00) == "gmv:large"
    assert segment_for_shop(999_999_99) == "gmv:large"
    assert segment_for_shop(1_000_000_00) == "gmv:xl"
    assert segment_for_shop(5_000_000_00) == "gmv:xl"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/engine/moat/test_peer_incident_etl.py::test_segment_for_shop_band_thresholds -v`
Expected: FAIL — `ModuleNotFoundError` / `ImportError: cannot import name 'segment_for_shop'`.

- [ ] **Step 3: Write minimal implementation**

```python
"""Plan 05 slice #5 — peer + incident ETL orchestrator.

Additive to the fixed moat kernels (emitter, peer_baselines,
incident_extractor). Builds the cross-tenant anonymized arm:
projection -> per-(detector, GMV-band) baselines -> incident library.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Any

import structlog

from .peer_baselines import K_FLOOR  # single source of truth for the floor

logger = structlog.get_logger()

# Trailing-90d GMV band thresholds in integer cents. A shop's band is the
# highest band whose lower bound it meets. Zero orders -> micro.
GMV_BANDS: tuple[tuple[str, int], ...] = (
    ("gmv:xl", 1_000_000_00),
    ("gmv:large", 250_000_00),
    ("gmv:mid", 50_000_00),
    ("gmv:small", 10_000_00),
    ("gmv:micro", 0),
)


def segment_for_shop(gmv_90d_cents: int) -> str:
    """Map trailing-90d GMV (integer cents) to a ``gmv:<band>`` segment."""
    for label, lower_cents in GMV_BANDS:
        if gmv_90d_cents >= lower_cents:
            return label
    return "gmv:micro"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/engine/moat/test_peer_incident_etl.py::test_segment_for_shop_band_thresholds -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add engine/calderyn_engine/moat/peer_incident_etl.py tests/engine/moat/test_peer_incident_etl.py
git commit -m "moat/peer_incident_etl: pin GMV-band segment function"
```

---

### Task 2: GMV resolver `gmv_band_for_shop` (DB-backed)

**Files:**
- Modify: `engine/calderyn_engine/moat/peer_incident_etl.py`
- Test: `tests/engine/moat/test_peer_incident_etl.py`

**Interfaces:**
- Consumes: `segment_for_shop` (Task 1).
- Produces: `async gmv_band_for_shop(conn, shop_id: str, run_date: date) -> str` — sums `order_fact.total_cents` over `[run_date-90d, run_date]` and returns the `"gmv:<band>"` segment. Used by the projection (Task 3).

- [ ] **Step 1: Write the failing test**

```python
async def _seed_shop(conn, shop_id: str, *, consent: bool) -> None:
    suffix = shop_id.replace("-", "")[-12:]
    await conn.execute(
        "INSERT INTO public.shops (id, shop_domain, peer_data_consent) "
        "VALUES ($1::uuid, $2, $3) "
        "ON CONFLICT (id) DO UPDATE SET peer_data_consent = EXCLUDED.peer_data_consent",
        shop_id, f"pie-{suffix}.myshopify.com", consent,
    )


async def _seed_order(conn, shop_id: str, *, total_cents: int, days_ago: int) -> None:
    await conn.execute(
        """
        INSERT INTO public.order_fact
          (id, shop_id, external_id, order_number, created_at_source,
           total_cents, subtotal_cents, source_version)
        VALUES (gen_random_uuid(), $1::uuid, $2, $3,
                now() - ($4::int * interval '1 day'), $5, $5,
                (extract(epoch from clock_timestamp())*1000)::bigint)
        """,
        shop_id, f"ord-{uuid.uuid4().hex[:8]}", f"#{uuid.uuid4().hex[:6]}",
        days_ago, total_cents,
    )


@pytest.mark.asyncio
async def test_gmv_band_for_shop_sums_trailing_90d(pg_pool):
    from calderyn_engine.moat.peer_incident_etl import gmv_band_for_shop
    async with pg_pool.acquire() as conn:
        shop_id = str(uuid.uuid4())
        await _seed_shop(conn, shop_id, consent=True)
        # $30,000 inside the window -> small; one stale order outside it ignored.
        await _seed_order(conn, shop_id, total_cents=30_000_00, days_ago=10)
        await _seed_order(conn, shop_id, total_cents=999_999_00, days_ago=200)
        band = await gmv_band_for_shop(conn, shop_id, date.today())
        assert band == "gmv:small"


@pytest.mark.asyncio
async def test_gmv_band_zero_orders_is_micro(pg_pool):
    from calderyn_engine.moat.peer_incident_etl import gmv_band_for_shop
    async with pg_pool.acquire() as conn:
        shop_id = str(uuid.uuid4())
        await _seed_shop(conn, shop_id, consent=True)
        band = await gmv_band_for_shop(conn, shop_id, date.today())
        assert band == "gmv:micro"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/calderyn_test uv run pytest "tests/engine/moat/test_peer_incident_etl.py::test_gmv_band_for_shop_sums_trailing_90d" -v`
Expected: FAIL — `ImportError: cannot import name 'gmv_band_for_shop'`.

- [ ] **Step 3: Write minimal implementation** (append to `peer_incident_etl.py`)

```python
async def gmv_band_for_shop(conn: Any, shop_id: str, run_date: date) -> str:
    """Return the ``gmv:<band>`` segment for ``shop_id`` at ``run_date``.

    Bands off trailing-90d gross merchandise value
    (sum of ``order_fact.total_cents`` in ``[run_date-90d, run_date]``).
    """
    row = await conn.fetchrow(
        """
        SELECT COALESCE(SUM(total_cents), 0)::bigint AS gmv_cents
          FROM public.order_fact
         WHERE shop_id = $1::uuid
           AND created_at_source >= ($2::date - INTERVAL '90 days')
           AND created_at_source <  ($2::date + INTERVAL '1 day')
        """,
        shop_id, run_date,
    )
    gmv_cents = int(row["gmv_cents"]) if row and row["gmv_cents"] is not None else 0
    return segment_for_shop(gmv_cents)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/calderyn_test uv run pytest "tests/engine/moat/test_peer_incident_etl.py" -k "gmv_band" -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add engine/calderyn_engine/moat/peer_incident_etl.py tests/engine/moat/test_peer_incident_etl.py
git commit -m "moat/peer_incident_etl: trailing-90d GMV band resolver"
```

---

### Task 3: Pseudonymized projection `project_alerts_for_day`

**Files:**
- Modify: `engine/calderyn_engine/moat/peer_incident_etl.py`
- Test: `tests/engine/moat/test_peer_incident_etl.py`

**Interfaces:**
- Consumes: `gmv_band_for_shop` (Task 2); `emit_moat_event` from `calderyn_engine.moat.emitter`; `pseudonym_for` for assertions.
- Produces: `async project_alerts_for_day(conn, *, run_date: date, pepper: str) -> int` — deletes this slice's prior `detection_fired` projection for `run_date`, then emits one `detection_fired` row per consenting-shop alert for that `day_bucket`; returns the count emitted. Proves A1 (pseudonyms only) and A2 (consent filter) and idempotency.

- [ ] **Step 1: Write the failing test**

```python
DETECTOR = "ad_tax_overload"
from calderyn_engine.moat.pseudonym import pseudonym_for

PEPPER = "pepper-test-slice5"


async def _seed_alert(conn, shop_id: str, *, day: date,
                      dollar_impact: Decimal, detector: str = DETECTOR) -> str:
    alert_id = str(uuid.uuid4())
    await conn.execute(
        """
        INSERT INTO public.alerts
          (id, shop_id, detector_id, entity_ref, status, severity,
           dollar_impact, day_bucket, first_seen_at, last_seen_at)
        VALUES ($1::uuid, $2::uuid, $3, '{}'::jsonb, 'open', 'high',
                $4, $5, now(), now())
        """,
        alert_id, shop_id, detector, dollar_impact, day,
    )
    return alert_id


@pytest.mark.asyncio
async def test_nonconsenting_alerts_not_projected(pg_pool):
    from calderyn_engine.moat.peer_incident_etl import project_alerts_for_day
    async with pg_pool.acquire() as conn:
        day = date.today()
        consenting = str(uuid.uuid4())
        non = str(uuid.uuid4())
        await _seed_shop(conn, consenting, consent=True)
        await _seed_shop(conn, non, consent=False)
        await _seed_alert(conn, consenting, day=day, dollar_impact=Decimal("300"))
        await _seed_alert(conn, non, day=day, dollar_impact=Decimal("9999"))

        n = await project_alerts_for_day(conn, run_date=day, pepper=PEPPER)
        assert n == 1  # only the consenting shop's alert

        non_pseud = pseudonym_for(non, PEPPER)
        rows = await conn.fetch(
            "SELECT pseudonym_id FROM moat.event_log "
            "WHERE event_kind='detection_fired' "
            "AND (payload->>'day_bucket')::date = $1", day,
        )
        assert all(r["pseudonym_id"] != non_pseud for r in rows)


@pytest.mark.asyncio
async def test_projection_writes_only_pseudonyms(pg_pool):
    from calderyn_engine.moat.peer_incident_etl import project_alerts_for_day
    async with pg_pool.acquire() as conn:
        day = date.today()
        shop_id = str(uuid.uuid4())
        await _seed_shop(conn, shop_id, consent=True)
        await _seed_alert(conn, shop_id, day=day, dollar_impact=Decimal("500"))

        await project_alerts_for_day(conn, run_date=day, pepper=PEPPER)

        rows = await conn.fetch(
            "SELECT pseudonym_id, payload FROM moat.event_log "
            "WHERE event_kind='detection_fired' "
            "AND (payload->>'day_bucket')::date = $1", day,
        )
        assert len(rows) == 1
        # A1: no raw shop_id anywhere; pseudonym matches HMAC.
        assert rows[0]["pseudonym_id"] == pseudonym_for(shop_id, PEPPER)
        assert rows[0]["pseudonym_id"] != shop_id
        payload = json.loads(rows[0]["payload"])
        assert "shop_id" not in payload
        assert payload["dollar_impact"] == 500
        assert payload["segment"].startswith("gmv:")


@pytest.mark.asyncio
async def test_projection_idempotent_on_rerun(pg_pool):
    from calderyn_engine.moat.peer_incident_etl import project_alerts_for_day
    async with pg_pool.acquire() as conn:
        day = date.today()
        shop_id = str(uuid.uuid4())
        await _seed_shop(conn, shop_id, consent=True)
        await _seed_alert(conn, shop_id, day=day, dollar_impact=Decimal("250"))

        await project_alerts_for_day(conn, run_date=day, pepper=PEPPER)
        await project_alerts_for_day(conn, run_date=day, pepper=PEPPER)

        count = await conn.fetchval(
            "SELECT count(*) FROM moat.event_log "
            "WHERE event_kind='detection_fired' "
            "AND (payload->>'day_bucket')::date = $1", day,
        )
        assert count == 1  # second run replaced, did not double
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/calderyn_test uv run pytest "tests/engine/moat/test_peer_incident_etl.py" -k "projection or not_projected" -v`
Expected: FAIL — `ImportError: cannot import name 'project_alerts_for_day'`.

- [ ] **Step 3: Write minimal implementation** (append to `peer_incident_etl.py`)

```python
from .emitter import emit_moat_event


async def project_alerts_for_day(
    conn: Any, *, run_date: date, pepper: str
) -> int:
    """Project one day's consenting-shop alerts into ``moat.event_log``.

    Idempotent: deletes this slice's prior ``detection_fired`` projection
    for ``run_date`` (keyed on the in-payload ``day_bucket``) before
    re-emitting, so N runs for a day produce exactly one row set.
    Caller owns the transaction — the delete + re-emit MUST be one txn.
    """
    # Idempotency: drop prior projection for this day only. Seed rows that
    # carry no day_bucket in payload are never matched, so they survive.
    await conn.execute(
        """
        DELETE FROM moat.event_log
         WHERE event_kind = 'detection_fired'
           AND (payload->>'day_bucket')::date = $1
        """,
        run_date,
    )

    # A2: select alerts only for consenting shops. A non-consenting shop's
    # rows are never read, so its pseudonym is never resolved.
    alerts = await conn.fetch(
        """
        SELECT a.id::text AS alert_id, a.shop_id::text AS shop_id,
               a.detector_id, a.dollar_impact, a.severity, a.day_bucket
          FROM public.alerts a
          JOIN public.shops s ON s.id = a.shop_id
         WHERE s.peer_data_consent = true
           AND a.day_bucket = $1
        """,
        run_date,
    )

    emitted = 0
    for a in alerts:
        segment = await gmv_band_for_shop(conn, a["shop_id"], run_date)
        payload = {
            "alert_id": a["alert_id"],
            "severity": a["severity"],
            "detector_id": a["detector_id"],
            "dollar_impact": float(a["dollar_impact"]),
            "thresholds_used": {},
            "day_bucket": a["day_bucket"].isoformat(),
            "segment": segment,
        }
        wrote = await emit_moat_event(
            conn,
            shop_id=a["shop_id"],
            kind="detection_fired",
            payload=payload,
            pepper=pepper,
            peer_data_consent=True,  # SQL already proved consent; defense-in-depth
            detector_id=a["detector_id"],
        )
        if wrote:
            emitted += 1
    logger.info("peer_etl_projected", run_date=run_date.isoformat(), emitted=emitted)
    return emitted
```

> **Note for the implementer:** `emit_moat_event` validates `payload` against
> `PAYLOAD_MODELS['detection_fired']`. If that pydantic model rejects the extra
> `day_bucket`/`segment` keys (i.e. it is declared with `extra='forbid'`), the
> emit will raise. Before running Step 4, confirm the model's `extra` policy by
> reading `engine/calderyn_engine/moat/events.py`. If it forbids extras, do NOT
> modify the fixed model; instead carry `day_bucket`/`segment` by writing the
> projected rows with a direct `INSERT INTO moat.event_log (...)` that calls
> `pseudonym_for(shop_id, pepper)` inline (mirroring the emitter's resolve+insert)
> — this keeps A1/A2 intact and is still "reuse the emitter's logic" without
> fighting a strict model. Pick the path the model dictates; the tests above are
> agnostic to which path is taken.

- [ ] **Step 4: Run test to verify it passes**

Run: `TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/calderyn_test uv run pytest "tests/engine/moat/test_peer_incident_etl.py" -k "projection or not_projected" -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add engine/calderyn_engine/moat/peer_incident_etl.py tests/engine/moat/test_peer_incident_etl.py
git commit -m "moat/peer_incident_etl: consent-gated, idempotent alert projection (A1/A2)"
```

---

### Task 4: Segment-aware baseline aggregate `compute_peer_baselines_by_segment`

**Files:**
- Modify: `engine/calderyn_engine/moat/peer_incident_etl.py`
- Test: `tests/engine/moat/test_peer_incident_etl.py`

**Interfaces:**
- Consumes: `K_FLOOR` (re-exported from `peer_baselines.py`); projected rows carrying `payload->>'segment'` (Task 3).
- Produces: `async compute_peer_baselines_by_segment(conn, detector_id: str, segment: str) -> int` — mirrors the fixed kernel's SQL + `K_FLOOR` + upsert, additionally filtered to `payload->>'segment' = segment`. Returns the contributor count, or 0 when k-floored (no row). Proves A3 (k≥5) and A2 (consent JOIN preserved).

- [ ] **Step 1: Write the failing test**

```python
async def _seed_projected_event(conn, shop_id: str, *, consent: bool,
                                segment: str, dollar_impact: Decimal,
                                detector: str = DETECTOR) -> str:
    """Seed a shop + pseudonym + one projected detection_fired row carrying
    a segment label, the way Task 3's projection would."""
    await _seed_shop(conn, shop_id, consent=consent)
    pseud = pseudonym_for(shop_id, PEPPER)
    await conn.execute(
        "INSERT INTO moat_keys.shop_pseudonym (shop_id, pseudonym_id) "
        "VALUES ($1::uuid, $2) ON CONFLICT (shop_id) DO NOTHING",
        shop_id, pseud,
    )
    await conn.execute(
        "INSERT INTO moat.event_log "
        "(pseudonym_id, event_kind, detector_id, payload) "
        "VALUES ($1, 'detection_fired', $2, $3::jsonb)",
        pseud, detector,
        json.dumps({"dollar_impact": float(dollar_impact), "segment": segment}),
    )
    return pseud


async def _cleanup_baselines(conn, detector: str = DETECTOR) -> None:
    await conn.execute("DELETE FROM moat.peer_baselines WHERE detector_id=$1", detector)
    await conn.execute("DELETE FROM moat.event_log WHERE detector_id=$1", detector)


@pytest.mark.asyncio
async def test_baseline_4_contributors_suppressed(pg_pool):
    from calderyn_engine.moat.peer_incident_etl import compute_peer_baselines_by_segment
    async with pg_pool.acquire() as conn:
        await _cleanup_baselines(conn)
        for _ in range(4):  # one short of the k=5 floor
            await _seed_projected_event(
                conn, str(uuid.uuid4()), consent=True,
                segment="gmv:mid", dollar_impact=Decimal("100"),
            )
        n = await compute_peer_baselines_by_segment(conn, DETECTOR, "gmv:mid")
        assert n == 0  # A3: floor not met
        rows = await conn.fetch(
            "SELECT * FROM moat.peer_baselines "
            "WHERE detector_id=$1 AND segment=$2", DETECTOR, "gmv:mid",
        )
        assert rows == []  # no row written, not even n<5


@pytest.mark.asyncio
async def test_baseline_5_contributors_written(pg_pool):
    from calderyn_engine.moat.peer_incident_etl import compute_peer_baselines_by_segment
    async with pg_pool.acquire() as conn:
        await _cleanup_baselines(conn)
        for impact in (Decimal("100"), Decimal("200"), Decimal("300"),
                       Decimal("400"), Decimal("500")):
            await _seed_projected_event(
                conn, str(uuid.uuid4()), consent=True,
                segment="gmv:mid", dollar_impact=impact,
            )
        n = await compute_peer_baselines_by_segment(conn, DETECTOR, "gmv:mid")
        assert n == 5
        row = await conn.fetchrow(
            "SELECT p25, p50, p75, n FROM moat.peer_baselines "
            "WHERE detector_id=$1 AND segment=$2", DETECTOR, "gmv:mid",
        )
        assert int(row["n"]) == 5
        assert Decimal(row["p25"]) == Decimal("200")
        assert Decimal(row["p50"]) == Decimal("300")
        assert Decimal(row["p75"]) == Decimal("400")


@pytest.mark.asyncio
async def test_nonconsenting_shop_absent_from_baseline(pg_pool):
    from calderyn_engine.moat.peer_incident_etl import compute_peer_baselines_by_segment
    async with pg_pool.acquire() as conn:
        await _cleanup_baselines(conn)
        for _ in range(5):
            await _seed_projected_event(
                conn, str(uuid.uuid4()), consent=True,
                segment="gmv:mid", dollar_impact=Decimal("100"),
            )
        for _ in range(2):  # non-consenting outliers must not count
            await _seed_projected_event(
                conn, str(uuid.uuid4()), consent=False,
                segment="gmv:mid", dollar_impact=Decimal("9999"),
            )
        n = await compute_peer_baselines_by_segment(conn, DETECTOR, "gmv:mid")
        assert n == 5  # A2: only the 5 consenting shops
        row = await conn.fetchrow(
            "SELECT n, p50 FROM moat.peer_baselines "
            "WHERE detector_id=$1 AND segment=$2", DETECTOR, "gmv:mid",
        )
        assert int(row["n"]) == 5
        assert Decimal(row["p50"]) == Decimal("100")  # not the $9999 outliers


@pytest.mark.asyncio
async def test_baseline_segment_isolation(pg_pool):
    """Rows in another band must not bleed into this band's quartiles."""
    from calderyn_engine.moat.peer_incident_etl import compute_peer_baselines_by_segment
    async with pg_pool.acquire() as conn:
        await _cleanup_baselines(conn)
        for _ in range(5):
            await _seed_projected_event(
                conn, str(uuid.uuid4()), consent=True,
                segment="gmv:mid", dollar_impact=Decimal("100"),
            )
        for _ in range(5):  # different band, should be ignored for gmv:mid
            await _seed_projected_event(
                conn, str(uuid.uuid4()), consent=True,
                segment="gmv:xl", dollar_impact=Decimal("8000"),
            )
        n = await compute_peer_baselines_by_segment(conn, DETECTOR, "gmv:mid")
        assert n == 5
        row = await conn.fetchrow(
            "SELECT p50 FROM moat.peer_baselines "
            "WHERE detector_id=$1 AND segment=$2", DETECTOR, "gmv:mid",
        )
        assert Decimal(row["p50"]) == Decimal("100")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/calderyn_test uv run pytest "tests/engine/moat/test_peer_incident_etl.py" -k "baseline" -v`
Expected: FAIL — `ImportError: cannot import name 'compute_peer_baselines_by_segment'`.

- [ ] **Step 3: Write minimal implementation** (append to `peer_incident_etl.py`)

```python
async def compute_peer_baselines_by_segment(
    conn: Any, detector_id: str, segment: str
) -> int:
    """Per-(detector, segment) peer-quartile baseline.

    Mirrors ``moat.peer_baselines.compute_peer_baselines`` SQL shape,
    K_FLOOR, and upsert verbatim, but restricts the observation set to
    rows whose ``payload->>'segment'`` equals ``segment``. Additive — the
    fixed kernel is left untouched (it is still used by consent_purge).

    A2: the ``consenting`` CTE filters to ``peer_data_consent = true``.
    A3: a row is written only when ``count(distinct pseudonym_id) >= K_FLOOR``.
    Returns the contributor count, or 0 when the floor was not met.
    """
    row = await conn.fetchrow(
        """
        with consenting as (
          select sp.pseudonym_id
            from moat_keys.shop_pseudonym sp
            join public.shops s on s.id = sp.shop_id
           where s.peer_data_consent = true
        ),
        observations as (
          select e.pseudonym_id,
                 (e.payload->>'dollar_impact')::numeric as dollar_impact
            from moat.event_log e
            join consenting c on c.pseudonym_id = e.pseudonym_id
           where e.detector_id = $1
             and e.event_kind = 'detection_fired'
             and e.payload ? 'dollar_impact'
             and e.payload->>'segment' = $2
        ),
        agg as (
          select
            count(distinct pseudonym_id) as n,
            percentile_cont(0.25) within group (order by dollar_impact) as p25,
            percentile_cont(0.50) within group (order by dollar_impact) as p50,
            percentile_cont(0.75) within group (order by dollar_impact) as p75
          from observations
        )
        select n, p25, p50, p75 from agg
        """,
        detector_id, segment,
    )
    if row is None:
        return 0
    n_value = int(row["n"] or 0)
    if n_value < K_FLOOR:
        logger.info(
            "peer_baselines_skipped_k_floor",
            detector_id=detector_id, segment=segment,
            n=n_value, k_floor=K_FLOOR,
        )
        return 0
    await conn.execute(
        """
        INSERT INTO moat.peer_baselines
          (detector_id, segment, p25, p50, p75, n, computed_at)
        VALUES ($1, $2, $3, $4, $5, $6, now())
        ON CONFLICT (detector_id, segment) DO UPDATE SET
          p25 = EXCLUDED.p25, p50 = EXCLUDED.p50, p75 = EXCLUDED.p75,
          n = EXCLUDED.n, computed_at = EXCLUDED.computed_at
        """,
        detector_id, segment, row["p25"], row["p50"], row["p75"], n_value,
    )
    logger.info(
        "peer_baselines_upserted",
        detector_id=detector_id, segment=segment, n=n_value,
    )
    return n_value
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/calderyn_test uv run pytest "tests/engine/moat/test_peer_incident_etl.py" -k "baseline" -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add engine/calderyn_engine/moat/peer_incident_etl.py tests/engine/moat/test_peer_incident_etl.py
git commit -m "moat/peer_incident_etl: segment-aware baseline (k>=5, consent, per-band isolation)"
```

---

### Task 5: Baseline driver `run_peer_baselines`

**Files:**
- Modify: `engine/calderyn_engine/moat/peer_incident_etl.py`
- Test: `tests/engine/moat/test_peer_incident_etl.py`

**Interfaces:**
- Consumes: `compute_peer_baselines_by_segment` (Task 4).
- Produces: `async run_peer_baselines(conn) -> tuple[int, int]` — enumerates distinct `(detector_id, segment)` pairs present in projected `detection_fired` rows and calls the segment-aware aggregate for each; returns `(written, suppressed)`. Used by the orchestrator (Task 7).

- [ ] **Step 1: Write the failing test**

```python
@pytest.mark.asyncio
async def test_run_peer_baselines_counts_written_and_suppressed(pg_pool):
    from calderyn_engine.moat.peer_incident_etl import run_peer_baselines
    async with pg_pool.acquire() as conn:
        await _cleanup_baselines(conn)
        # gmv:mid -> 5 consenting => written
        for _ in range(5):
            await _seed_projected_event(
                conn, str(uuid.uuid4()), consent=True,
                segment="gmv:mid", dollar_impact=Decimal("100"),
            )
        # gmv:small -> 3 consenting => suppressed (k floor)
        for _ in range(3):
            await _seed_projected_event(
                conn, str(uuid.uuid4()), consent=True,
                segment="gmv:small", dollar_impact=Decimal("50"),
            )
        written, suppressed = await run_peer_baselines(conn)
        assert written == 1       # gmv:mid
        assert suppressed == 1    # gmv:small
        rows = await conn.fetch(
            "SELECT segment FROM moat.peer_baselines WHERE detector_id=$1", DETECTOR,
        )
        segs = {r["segment"] for r in rows}
        assert segs == {"gmv:mid"}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/calderyn_test uv run pytest "tests/engine/moat/test_peer_incident_etl.py::test_run_peer_baselines_counts_written_and_suppressed" -v`
Expected: FAIL — `ImportError: cannot import name 'run_peer_baselines'`.

- [ ] **Step 3: Write minimal implementation** (append to `peer_incident_etl.py`)

```python
async def run_peer_baselines(conn: Any) -> tuple[int, int]:
    """Recompute baselines for every (detector, segment) with projected data.

    Returns (written, suppressed): how many (detector, segment) pairs got a
    row vs. how many were k-floored.
    """
    pairs = await conn.fetch(
        """
        SELECT DISTINCT detector_id, payload->>'segment' AS segment
          FROM moat.event_log
         WHERE event_kind = 'detection_fired'
           AND detector_id IS NOT NULL
           AND payload ? 'segment'
        """
    )
    written = 0
    suppressed = 0
    for p in pairs:
        n = await compute_peer_baselines_by_segment(conn, p["detector_id"], p["segment"])
        if n >= K_FLOOR:
            written += 1
        else:
            suppressed += 1
    return written, suppressed
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/calderyn_test uv run pytest "tests/engine/moat/test_peer_incident_etl.py::test_run_peer_baselines_counts_written_and_suppressed" -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add engine/calderyn_engine/moat/peer_incident_etl.py tests/engine/moat/test_peer_incident_etl.py
git commit -m "moat/peer_incident_etl: baseline driver over distinct (detector, segment) pairs"
```

---

### Task 6: Incident driver `run_incident_library`

**Files:**
- Modify: `engine/calderyn_engine/moat/peer_incident_etl.py`
- Test: `tests/engine/moat/test_peer_incident_etl.py`

**Interfaces:**
- Consumes: `extract_incident` from `calderyn_engine.moat.incident_extractor`.
- Produces: `async run_incident_library(conn, *, run_date: date) -> int` — for consenting shops, finds the day's confirmed-loss alerts (`alert_feedback.kind='confirmed_loss'`) and calls `extract_incident` for each; returns the number of new library rows. Proves A2 on incidents + dedup.

- [ ] **Step 1: Write the failing test**

```python
async def _seed_confirmed_loss(conn, shop_id: str, alert_id: str, *,
                               loss_usd: Decimal, when_day: date,
                               evidence: dict | None = None) -> None:
    """Attach alert_context evidence + a confirmed_loss feedback row dated to
    when_day. Mirrors the shapes extract_incident + the incident driver read."""
    if evidence is not None:
        await conn.execute(
            "INSERT INTO public.alert_context (alert_id, evidence) "
            "VALUES ($1::uuid, $2::jsonb) "
            "ON CONFLICT (alert_id) DO UPDATE SET evidence = EXCLUDED.evidence",
            alert_id, json.dumps(evidence),
        )
    await conn.execute(
        """
        INSERT INTO public.alert_feedback
          (id, alert_id, shop_id, kind, note, created_by, created_at)
        VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'confirmed_loss',
                $3, 'tester', ($4::date + interval '6 hours'))
        """,
        alert_id, shop_id, f"loss={loss_usd}", when_day,
    )


@pytest.mark.asyncio
async def test_incident_extracted_for_confirmed_loss(pg_pool):
    from calderyn_engine.moat.peer_incident_etl import run_incident_library
    async with pg_pool.acquire() as conn:
        await conn.execute("DELETE FROM moat.incident_library WHERE detector_id=$1", DETECTOR)
        day = date.today()
        shop_id = str(uuid.uuid4())
        await _seed_shop(conn, shop_id, consent=True)
        alert_id = await _seed_alert(conn, shop_id, day=day, dollar_impact=Decimal("400"))
        await _seed_confirmed_loss(conn, shop_id, alert_id,
                                   loss_usd=Decimal("400"), when_day=day,
                                   evidence={"ratio_bucket": "high"})
        n = await run_incident_library(conn, run_date=day)
        assert n == 1
        rows = await conn.fetch(
            "SELECT detector_id FROM moat.incident_library WHERE detector_id=$1", DETECTOR,
        )
        assert len(rows) == 1


@pytest.mark.asyncio
async def test_incident_dedup_skips_second(pg_pool):
    from calderyn_engine.moat.peer_incident_etl import run_incident_library
    async with pg_pool.acquire() as conn:
        await conn.execute("DELETE FROM moat.incident_library WHERE detector_id=$1", DETECTOR)
        day = date.today()
        shop_id = str(uuid.uuid4())
        await _seed_shop(conn, shop_id, consent=True)
        a1 = await _seed_alert(conn, shop_id, day=day, dollar_impact=Decimal("400"))
        await _seed_confirmed_loss(conn, shop_id, a1, loss_usd=Decimal("400"),
                                   when_day=day, evidence={"ratio_bucket": "high"})
        first = await run_incident_library(conn, run_date=day)
        # Second confirmed loss, same detector + same evidence signature.
        a2 = await _seed_alert(conn, shop_id, day=day, dollar_impact=Decimal("400"))
        await _seed_confirmed_loss(conn, shop_id, a2, loss_usd=Decimal("400"),
                                   when_day=day, evidence={"ratio_bucket": "high"})
        second = await run_incident_library(conn, run_date=day)
        assert first == 1
        assert second == 0  # exact-signature dup skipped by extract_incident


@pytest.mark.asyncio
async def test_nonconsenting_confirmed_loss_skipped(pg_pool):
    from calderyn_engine.moat.peer_incident_etl import run_incident_library
    async with pg_pool.acquire() as conn:
        await conn.execute("DELETE FROM moat.incident_library WHERE detector_id=$1", DETECTOR)
        day = date.today()
        shop_id = str(uuid.uuid4())
        await _seed_shop(conn, shop_id, consent=False)  # NOT consenting
        alert_id = await _seed_alert(conn, shop_id, day=day, dollar_impact=Decimal("400"))
        await _seed_confirmed_loss(conn, shop_id, alert_id, loss_usd=Decimal("400"),
                                   when_day=day, evidence={"ratio_bucket": "high"})
        n = await run_incident_library(conn, run_date=day)
        assert n == 0  # A2: non-consenting losses never enter the library
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/calderyn_test uv run pytest "tests/engine/moat/test_peer_incident_etl.py" -k "incident or confirmed_loss" -v`
Expected: FAIL — `ImportError: cannot import name 'run_incident_library'`.

- [ ] **Step 3: Write minimal implementation** (append to `peer_incident_etl.py`)

```python
from decimal import Decimal as _Decimal
import re as _re

from .incident_extractor import extract_incident


def _loss_usd_from_note(note: str | None) -> _Decimal:
    """Parse the confirmed-loss USD out of the feedback note ('loss=<n>').

    Prod feedback for confirmed_loss carries the amount; in this slice's
    seed it is stored as 'loss=<n>'. Falls back to 0 when unparseable so a
    malformed note never crashes the night (the extractor still records the
    pattern; the dollar anchor is then 0).
    """
    if not note:
        return _Decimal("0")
    m = _re.search(r"loss=([0-9]+(?:\.[0-9]+)?)", note)
    return _Decimal(m.group(1)) if m else _Decimal("0")


async def run_incident_library(conn: Any, *, run_date: date) -> int:
    """Harvest the day's consenting-shop confirmed losses into the library.

    A2: only consenting shops' confirmed losses are considered. Dedup +
    PII-stripping are handled inside extract_incident. Returns the number
    of new library rows inserted.
    """
    losses = await conn.fetch(
        """
        SELECT f.alert_id::text AS alert_id, f.note
          FROM public.alert_feedback f
          JOIN public.shops s ON s.id = f.shop_id
         WHERE s.peer_data_consent = true
           AND f.kind = 'confirmed_loss'
           AND f.created_at >= $1::date
           AND f.created_at <  ($1::date + interval '1 day')
        """,
        run_date,
    )
    inserted = 0
    for row in losses:
        wrote = await extract_incident(
            conn, row["alert_id"], _loss_usd_from_note(row["note"])
        )
        if wrote:
            inserted += 1
    logger.info("peer_etl_incidents", run_date=run_date.isoformat(), inserted=inserted)
    return inserted
```

> **Implementer note:** `alert_feedback.kind` is an ENUM (#2 pins its labels). This
> slice reads the literal `'confirmed_loss'`, which is the value present in prod
> moat payloads. If the enum's confirmed-loss label differs, read it from
> `tests/engine/schema/migrations/*alert_feedback*.sql` and substitute the exact
> label — do NOT invent one. The prod `outcome_confirmed` payload also carries
> `confirmed_loss_usd`; if your DB models the loss amount on a column rather than
> the note, prefer that column over `_loss_usd_from_note`. The tests above seed the
> note form; adjust `_seed_confirmed_loss` and `_loss_usd_from_note` together if you
> switch to a column, keeping them consistent (writing-plans: type consistency).

- [ ] **Step 4: Run test to verify it passes**

Run: `TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/calderyn_test uv run pytest "tests/engine/moat/test_peer_incident_etl.py" -k "incident or confirmed_loss" -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add engine/calderyn_engine/moat/peer_incident_etl.py tests/engine/moat/test_peer_incident_etl.py
git commit -m "moat/peer_incident_etl: consent-gated confirmed-loss incident driver"
```

---

### Task 7: Orchestrator `run_peer_incident_etl` + `EtlReport`

**Files:**
- Modify: `engine/calderyn_engine/moat/peer_incident_etl.py`
- Test: `tests/engine/moat/test_peer_incident_etl.py`

**Interfaces:**
- Consumes: `project_alerts_for_day` (T3), `run_peer_baselines` (T5), `run_incident_library` (T6).
- Produces: `EtlReport` dataclass `{alerts_projected: int, baselines_written: int, baselines_suppressed: int, incidents_extracted: int}`; `async run_peer_incident_etl(conn, *, run_date: date, pepper: str) -> EtlReport`. **This is the seam #4 (`train-cron`) invokes.** Caller owns the transaction.

- [ ] **Step 1: Write the failing test**

```python
@pytest.mark.asyncio
async def test_etl_report_counts(pg_pool):
    from calderyn_engine.moat.peer_incident_etl import run_peer_incident_etl, EtlReport
    async with pg_pool.acquire() as conn:
        await _cleanup_baselines(conn)
        await conn.execute("DELETE FROM moat.incident_library WHERE detector_id=$1", DETECTOR)
        day = date.today()

        # 5 consenting shops in gmv:micro (no orders) each with one alert at
        # $100..$500 -> projection emits 5; baseline writes 1; suppresses 0.
        shop_ids = []
        for impact in (Decimal("100"), Decimal("200"), Decimal("300"),
                       Decimal("400"), Decimal("500")):
            sid = str(uuid.uuid4())
            shop_ids.append(sid)
            await _seed_shop(conn, sid, consent=True)
            await _seed_alert(conn, sid, day=day, dollar_impact=impact)
        # One of them confirms a loss -> 1 incident.
        a_conf = await _seed_alert(conn, shop_ids[0], day=day, dollar_impact=Decimal("100"))
        await _seed_confirmed_loss(conn, shop_ids[0], a_conf,
                                   loss_usd=Decimal("100"), when_day=day,
                                   evidence={"ratio_bucket": "low"})

        report = await run_peer_incident_etl(conn, run_date=day, pepper=PEPPER)
        assert isinstance(report, EtlReport)
        assert report.alerts_projected == 6   # 5 + the extra confirmed-loss alert
        assert report.baselines_written == 1  # gmv:micro met k=5
        assert report.baselines_suppressed == 0
        assert report.incidents_extracted == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/calderyn_test uv run pytest "tests/engine/moat/test_peer_incident_etl.py::test_etl_report_counts" -v`
Expected: FAIL — `ImportError: cannot import name 'run_peer_incident_etl'`.

- [ ] **Step 3: Write minimal implementation** (append to `peer_incident_etl.py`; put the `@dataclass` near the top imports region)

```python
@dataclass
class EtlReport:
    """Per-night ETL outcome counts (for #4's observability / fail-visibly)."""
    alerts_projected: int
    baselines_written: int
    baselines_suppressed: int
    incidents_extracted: int


async def run_peer_incident_etl(
    conn: Any, *, run_date: date, pepper: str
) -> EtlReport:
    """Run the nightly cross-tenant ETL: project -> baselines -> incidents.

    Caller owns the transaction (this function does not BEGIN/COMMIT) and
    supplies ``pepper`` (this function never reads env). Any sub-step error
    propagates to the caller so a failed night rolls back as a unit.
    """
    projected = await project_alerts_for_day(conn, run_date=run_date, pepper=pepper)
    written, suppressed = await run_peer_baselines(conn)
    incidents = await run_incident_library(conn, run_date=run_date)
    report = EtlReport(
        alerts_projected=projected,
        baselines_written=written,
        baselines_suppressed=suppressed,
        incidents_extracted=incidents,
    )
    logger.info(
        "peer_etl_complete",
        run_date=run_date.isoformat(),
        alerts_projected=projected,
        baselines_written=written,
        baselines_suppressed=suppressed,
        incidents_extracted=incidents,
    )
    return report
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/calderyn_test uv run pytest "tests/engine/moat/test_peer_incident_etl.py::test_etl_report_counts" -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add engine/calderyn_engine/moat/peer_incident_etl.py tests/engine/moat/test_peer_incident_etl.py
git commit -m "moat/peer_incident_etl: orchestrator + EtlReport (seam for #4)"
```

---

### Task 8: Full-suite green + module docstring + export surface

**Files:**
- Modify: `engine/calderyn_engine/moat/peer_incident_etl.py` (final docstring/exports only)
- Test: whole engine suite (no new test file changes)

**Interfaces:**
- Consumes: everything above.
- Produces: a clean public surface (`__all__`) so #4 and #3 import stable names.

- [ ] **Step 1: Add the export surface** (append to `peer_incident_etl.py`)

```python
__all__ = [
    "GMV_BANDS",
    "EtlReport",
    "segment_for_shop",
    "gmv_band_for_shop",
    "project_alerts_for_day",
    "compute_peer_baselines_by_segment",
    "run_peer_baselines",
    "run_incident_library",
    "run_peer_incident_etl",
]
```

- [ ] **Step 2: Run the whole moat suite**

Run: `TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/calderyn_test uv run pytest tests/engine/moat -v`
Expected: PASS — all new `test_peer_incident_etl.py` tests plus the pre-existing moat tests (`test_peer_baselines.py`, `test_consent_purge.py`, etc.) still green (proves the additive function did not regress the fixed kernel).

- [ ] **Step 3: Run the full engine suite (CI parity)**

Run: `TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/calderyn_test uv run pytest tests/engine -q`
Expected: PASS (or only the unrelated pre-existing skips). No failures introduced.

- [ ] **Step 4: Commit**

```bash
git add engine/calderyn_engine/moat/peer_incident_etl.py
git commit -m "moat/peer_incident_etl: public export surface; full suite green"
```

---

## Self-Review

**1. Spec coverage:**
- Projection (spec §4) → Task 3 (consent filter, A1/A2, idempotency). ✓
- Segment definition (spec §3) → Tasks 1–2 (`segment_for_shop`, `gmv_band_for_shop`). ✓
- k≥5 + consent enforcement (spec §5) → Task 4 (`compute_peer_baselines_by_segment`) + Task 5 driver. ✓
- Incident library (spec §6) → Task 6. ✓
- SEAM-OUT to #3 (spec §7) → `moat.peer_baselines` shape is unchanged and written by Task 4/5; documented in the spec; no code beyond writing the table. ✓
- Orchestrator entry point for #4 (spec §8) → Task 7. ✓
- Invariant tests (spec §9): A3 suppress@4 (T4 `test_baseline_4_contributors_suppressed`), A2 non-consenting absent (T4 `test_nonconsenting_shop_absent_from_baseline`, T3 `test_nonconsenting_alerts_not_projected`, T6 `test_nonconsenting_confirmed_loss_skipped`), A1 pseudonyms-only (T3 `test_projection_writes_only_pseudonyms`). ✓

**2. Placeholder scan:** No "TBD"/"handle edge cases"/bare "write tests" — every code step shows full code; every test step shows real pytest. The two implementer notes (Task 3 model `extra` policy; Task 6 enum label) are explicit conditional instructions with the exact file to check and the exact fallback, not placeholders. ✓

**3. Type consistency:** `segment_for_shop(int)->str`, `gmv_band_for_shop(conn,str,date)->str`, `project_alerts_for_day(conn,*,run_date,pepper)->int`, `compute_peer_baselines_by_segment(conn,str,str)->int`, `run_peer_baselines(conn)->tuple[int,int]`, `run_incident_library(conn,*,run_date)->int`, `run_peer_incident_etl(conn,*,run_date,pepper)->EtlReport`, `EtlReport{alerts_projected,baselines_written,baselines_suppressed,incidents_extracted}` — names/signatures identical across the tasks that define and call them. `K_FLOOR` is imported, never redefined. ✓

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-16-moat-peer-incident-etl-plan.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration. REQUIRED SUB-SKILL: superpowers:subagent-driven-development.
2. **Inline Execution** — execute tasks in this session using executing-plans, batch with checkpoints. REQUIRED SUB-SKILL: superpowers:executing-plans.

Which approach?
