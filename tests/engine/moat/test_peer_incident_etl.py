"""Slice #5 — peer + incident ETL tests. DB-backed tests use the parent
pg_pool fixture and skip unless TEST_DATABASE_URL points at a local pg."""

from __future__ import annotations

import json
import uuid
from datetime import date
from decimal import Decimal

import pytest

from calderyn_engine.moat.peer_incident_etl import segment_for_shop
from calderyn_engine.moat.pseudonym import pseudonym_for

PEPPER = "pepper-test-slice5"
DETECTOR = "ad_tax_overload"


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


# ---------------------------------------------------------------------------
# Shared seed helpers (mirror tests/engine/moat/test_peer_baselines.py style).
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# Task 3 — pseudonymized projection (A1/A2 + idempotency).
# ---------------------------------------------------------------------------


async def _clean_day_projection(conn, day: date) -> None:
    """Remove the day's projected events + any alerts dated to ``day`` so a
    projection test is hermetic regardless of what earlier same-session tests
    seeded (alerts all share ``day_bucket = today``; the session truncate runs
    once, not per test)."""
    await conn.execute(
        "DELETE FROM moat.event_log WHERE event_kind='detection_fired' "
        "AND (payload->>'day_bucket')::date = $1", day,
    )
    await conn.execute("DELETE FROM public.alerts WHERE day_bucket = $1", day)
    # The incident ETL harvests confirmed-loss feedback day-globally (across ALL
    # consenting shops), so an earlier same-session test's confirmed_loss dated to
    # ``day`` would inflate this test's count. Clear the day's feedback too, using
    # the same [day, day+1) predicate run_incident_library filters on.
    await conn.execute(
        "DELETE FROM public.alert_feedback "
        "WHERE created_at >= $1::date AND created_at < ($1::date + interval '1 day')",
        day,
    )


async def _seed_alert(conn, shop_id: str, *, day: date,
                      dollar_impact: Decimal, detector: str = DETECTOR) -> str:
    alert_id = str(uuid.uuid4())
    # entity_ref must be unique per alert: public.alerts has a unique
    # constraint on (shop_id, detector_id, entity_ref), so multiple alerts
    # for one shop+detector (e.g. the dedup test, the ETL report fixture)
    # would otherwise collide. The incident signature is derived from
    # alert_context.evidence, not entity_ref, so a unique ref here does not
    # change which incidents dedup.
    entity_ref = json.dumps({"ref": alert_id})
    await conn.execute(
        """
        INSERT INTO public.alerts
          (id, shop_id, detector_id, entity_ref, status, severity,
           dollar_impact, day_bucket, first_seen_at, last_seen_at)
        VALUES ($1::uuid, $2::uuid, $3, $6::jsonb, 'open', 'high',
                $4, $5, now(), now())
        """,
        alert_id, shop_id, detector, dollar_impact, day, entity_ref,
    )
    return alert_id


@pytest.mark.asyncio
async def test_nonconsenting_alerts_not_projected(pg_pool):
    from calderyn_engine.moat.peer_incident_etl import project_alerts_for_day
    async with pg_pool.acquire() as conn:
        day = date.today()
        await _clean_day_projection(conn, day)
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
        await _clean_day_projection(conn, day)
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
        await _clean_day_projection(conn, day)
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


# ---------------------------------------------------------------------------
# Task 4 — segment-aware baseline aggregate (A3 + A2 + per-band isolation).
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# Task 5 — baseline driver over distinct (detector, segment) pairs.
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# Task 6 — confirmed-loss incident driver (A2 + dedup).
# ---------------------------------------------------------------------------


async def _seed_confirmed_loss(conn, shop_id: str, alert_id: str, *,
                               loss_usd: Decimal, when_day: date,
                               evidence: dict | None = None) -> None:
    """Attach alert_context evidence + a confirmed_loss feedback row dated to
    when_day. Mirrors the shapes extract_incident + the incident driver read.

    NOTE (schema adaptation): public.alert_context has a NOT-NULL shop_id with
    no default (the plan's draft omitted it), so we thread shop_id through.
    """
    if evidence is not None:
        await conn.execute(
            "INSERT INTO public.alert_context (alert_id, shop_id, evidence) "
            "VALUES ($1::uuid, $2::uuid, $3::jsonb) "
            "ON CONFLICT (alert_id) DO UPDATE SET evidence = EXCLUDED.evidence",
            alert_id, shop_id, json.dumps(evidence),
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
        await _clean_day_projection(conn, day)
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
        await _clean_day_projection(conn, day)
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
        await _clean_day_projection(conn, day)
        shop_id = str(uuid.uuid4())
        await _seed_shop(conn, shop_id, consent=False)  # NOT consenting
        alert_id = await _seed_alert(conn, shop_id, day=day, dollar_impact=Decimal("400"))
        await _seed_confirmed_loss(conn, shop_id, alert_id, loss_usd=Decimal("400"),
                                   when_day=day, evidence={"ratio_bucket": "high"})
        n = await run_incident_library(conn, run_date=day)
        assert n == 0  # A2: non-consenting losses never enter the library


# ---------------------------------------------------------------------------
# Task 7 — orchestrator + EtlReport (the seam #4 invokes).
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_etl_report_counts(pg_pool):
    from calderyn_engine.moat.peer_incident_etl import run_peer_incident_etl, EtlReport
    async with pg_pool.acquire() as conn:
        await _cleanup_baselines(conn)
        await conn.execute("DELETE FROM moat.incident_library WHERE detector_id=$1", DETECTOR)
        day = date.today()
        await _clean_day_projection(conn, day)

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
