"""Plan 05 Task 20 — coverage of ``purge_shop_contributions``.

Two cases (testcontainer pg fixture):

  1. Purge removes only the target shop's event_log rows and leaves
     other shops untouched.
  2. After purge, the peer-baseline ETL is re-fired for every
     affected (detector, segment) pair.
"""

from __future__ import annotations

import json
import uuid
from datetime import date
from decimal import Decimal

import pytest

from calderyn_engine.moat.consent_purge import purge_shop_contributions
from calderyn_engine.moat.peer_baselines import compute_peer_baselines
from calderyn_engine.moat.pseudonym import pseudonym_for

PEPPER = "pepper-test-task-20"
DETECTOR = "sku_stockout_vs_spend"
SEGMENT = "cat:electronics"


async def _seed(conn, shop_id: str, *, consent: bool, impacts: list[Decimal]) -> str:
    suffix = shop_id.replace("-", "")[-12:]
    await conn.execute(
        "INSERT INTO public.shops (id, shop_domain, peer_data_consent) "
        "VALUES ($1::uuid, $2, $3) "
        "ON CONFLICT (id) DO UPDATE SET peer_data_consent = EXCLUDED.peer_data_consent",
        shop_id,
        f"cp-{suffix}.myshopify.com",
        consent,
    )
    pseudonym = pseudonym_for(shop_id, PEPPER)
    await conn.execute(
        "INSERT INTO moat_keys.shop_pseudonym (shop_id, pseudonym_id) "
        "VALUES ($1::uuid, $2) ON CONFLICT (shop_id) DO NOTHING",
        shop_id,
        pseudonym,
    )
    for impact in impacts:
        await conn.execute(
            "INSERT INTO moat.event_log "
            "(pseudonym_id, event_kind, detector_id, payload) "
            "VALUES ($1, 'detection_fired', $2, $3::jsonb)",
            pseudonym,
            DETECTOR,
            json.dumps({"dollar_impact": float(impact)}),
        )
    return pseudonym


async def _cleanup(conn) -> None:
    await conn.execute("DELETE FROM moat.peer_baselines WHERE detector_id = $1", DETECTOR)
    await conn.execute("DELETE FROM moat.event_log WHERE detector_id = $1", DETECTOR)


@pytest.mark.asyncio
async def test_purge_removes_only_target_shop(pg_pool) -> None:
    async with pg_pool.acquire() as conn:
        await _cleanup(conn)
        target_id = str(uuid.uuid4())
        keep_id = str(uuid.uuid4())
        target_pseudonym = await _seed(
            conn, target_id, consent=True, impacts=[Decimal("100")] * 5
        )
        keep_pseudonym = await _seed(
            conn, keep_id, consent=True, impacts=[Decimal("200")] * 5
        )

        deleted = await purge_shop_contributions(conn, target_pseudonym, pepper=PEPPER, run_date=date.today())
        assert deleted == 5

        target_remaining = await conn.fetchval(
            "SELECT count(*) FROM moat.event_log WHERE pseudonym_id = $1",
            target_pseudonym,
        )
        keep_remaining = await conn.fetchval(
            "SELECT count(*) FROM moat.event_log WHERE pseudonym_id = $1",
            keep_pseudonym,
        )
        assert target_remaining == 0
        assert keep_remaining == 5


@pytest.mark.asyncio
async def test_purge_reruns_etl(pg_pool) -> None:
    async with pg_pool.acquire() as conn:
        await _cleanup(conn)
        # Six consenting shops → baseline computes successfully.
        shops = [str(uuid.uuid4()) for _ in range(6)]
        pseudonyms = []
        for sid in shops:
            pseudonyms.append(
                await _seed(conn, sid, consent=True, impacts=[Decimal("100")])
            )

        # Build the baseline first so the purge has something to re-run.
        n_initial = await compute_peer_baselines(conn, DETECTOR, SEGMENT)
        assert n_initial == 6

        # Purge one shop → ETL must re-fire and the new n is 5.
        await purge_shop_contributions(conn, pseudonyms[0], pepper=PEPPER, run_date=date.today())

        row = await conn.fetchrow(
            "SELECT n FROM moat.peer_baselines "
            "WHERE detector_id = $1 AND segment = $2",
            DETECTOR,
            SEGMENT,
        )
        assert row is not None
        assert int(row["n"]) == 5


# ---------------------------------------------------------------------------
# §9.6 GDPR blocker — per-segment re-aggregation + delete-stale (A2/A3).
#
# Slice #5 writes PER-SEGMENT baselines keyed (detector_id, segment) off the
# in-payload ``segment`` label (via compute_peer_baselines_by_segment). These
# tests pin that a consent purge re-aggregates those segment-keyed rows so the
# withdrawn shop's influence is fully gone — including DELETING a row whose
# distinct consenting contributors drop below the k>=5 floor (the exact
# privacy gap: a "write only when >=5" recompute would leave the stale row).
# A distinct detector id keeps these hermetic from the legacy cases above.
# ---------------------------------------------------------------------------

SEG_DETECTOR = "margin_erosion"
GMV_SEGMENT = "gmv:large"


async def _seed_segmented(
    conn, shop_id: str, *, consent: bool, segment: str, impact: Decimal
) -> str:
    """Seed a shop + pseudonym + one projected detection_fired row carrying a
    ``segment`` label, exactly the shape slice #5's projection writes."""
    suffix = shop_id.replace("-", "")[-12:]
    await conn.execute(
        "INSERT INTO public.shops (id, shop_domain, peer_data_consent) "
        "VALUES ($1::uuid, $2, $3) "
        "ON CONFLICT (id) DO UPDATE SET peer_data_consent = EXCLUDED.peer_data_consent",
        shop_id,
        f"cps-{suffix}.myshopify.com",
        consent,
    )
    pseudonym = pseudonym_for(shop_id, PEPPER)
    await conn.execute(
        "INSERT INTO moat_keys.shop_pseudonym (shop_id, pseudonym_id) "
        "VALUES ($1::uuid, $2) ON CONFLICT (shop_id) DO NOTHING",
        shop_id,
        pseudonym,
    )
    await conn.execute(
        "INSERT INTO moat.event_log "
        "(pseudonym_id, event_kind, detector_id, payload) "
        "VALUES ($1, 'detection_fired', $2, $3::jsonb)",
        pseudonym,
        SEG_DETECTOR,
        json.dumps({"dollar_impact": float(impact), "segment": segment}),
    )
    return pseudonym


async def _cleanup_segmented(conn) -> None:
    await conn.execute(
        "DELETE FROM moat.peer_baselines WHERE detector_id = $1", SEG_DETECTOR
    )
    await conn.execute(
        "DELETE FROM moat.event_log WHERE detector_id = $1", SEG_DETECTOR
    )


@pytest.mark.asyncio
async def test_purge_deletes_sub_k_segment_baseline(pg_pool) -> None:
    """THE GDPR PROOF: a (detector, segment) baseline at exactly k=5 whose
    contributors drop to 4 after a purge must have its peer_baselines row
    DELETED — not left stale carrying the withdrawn shop's influence."""
    from calderyn_engine.moat.peer_incident_etl import (
        compute_peer_baselines_by_segment,
    )

    async with pg_pool.acquire() as conn:
        await _cleanup_segmented(conn)
        try:
            # 5 consenting shops in one GMV band -> baseline exists at n=5.
            shops = [str(uuid.uuid4()) for _ in range(5)]
            pseudonyms = []
            for sid, impact in zip(
                shops,
                (Decimal("100"), Decimal("200"), Decimal("300"),
                 Decimal("400"), Decimal("500")),
            ):
                pseudonyms.append(
                    await _seed_segmented(
                        conn, sid, consent=True, segment=GMV_SEGMENT,
                        impact=impact,
                    )
                )

            n_initial = await compute_peer_baselines_by_segment(
                conn, SEG_DETECTOR, GMV_SEGMENT
            )
            assert n_initial == 5
            pre = await conn.fetchrow(
                "SELECT n FROM moat.peer_baselines "
                "WHERE detector_id = $1 AND segment = $2",
                SEG_DETECTOR,
                GMV_SEGMENT,
            )
            assert pre is not None and int(pre["n"]) == 5

            # Revoke + purge ONE shop -> band falls to 4 contributors.
            deleted = await purge_shop_contributions(conn, pseudonyms[0], pepper=PEPPER, run_date=date.today())
            assert deleted == 1

            # The band now has 4 distinct consenting contributors.
            remaining = await conn.fetchval(
                "SELECT count(DISTINCT pseudonym_id) FROM moat.event_log "
                "WHERE detector_id = $1 AND payload->>'segment' = $2",
                SEG_DETECTOR,
                GMV_SEGMENT,
            )
            assert remaining == 4

            # k>=5 re-enforced: the segment-keyed baseline row is GONE,
            # not stale.
            row = await conn.fetchrow(
                "SELECT * FROM moat.peer_baselines "
                "WHERE detector_id = $1 AND segment = $2",
                SEG_DETECTOR,
                GMV_SEGMENT,
            )
            assert row is None
        finally:
            # Clean what we seeded: these rows carry a segment label and would
            # otherwise pollute slice #5's global run_peer_baselines tests.
            await _cleanup_segmented(conn)


@pytest.mark.asyncio
async def test_purge_recomputes_segment_baseline_above_floor(pg_pool) -> None:
    """A band that stays >=5 after a purge is RECOMPUTED without the withdrawn
    shop: row present, n decremented to 5, quartiles no longer reflect it."""
    from calderyn_engine.moat.peer_incident_etl import (
        compute_peer_baselines_by_segment,
    )

    async with pg_pool.acquire() as conn:
        await _cleanup_segmented(conn)
        try:
            # 6 consenting shops; the first carries an extreme high value that
            # skews the upper quartiles while it is present.
            shops = [str(uuid.uuid4()) for _ in range(6)]
            impacts = [
                Decimal("100000"),  # the to-be-purged extreme
                Decimal("100"),
                Decimal("200"),
                Decimal("300"),
                Decimal("400"),
                Decimal("500"),
            ]
            pseudonyms = []
            for sid, impact in zip(shops, impacts):
                pseudonyms.append(
                    await _seed_segmented(
                        conn, sid, consent=True, segment="gmv:mid",
                        impact=impact,
                    )
                )

            n_initial = await compute_peer_baselines_by_segment(
                conn, SEG_DETECTOR, "gmv:mid"
            )
            assert n_initial == 6
            pre = await conn.fetchrow(
                "SELECT p75 FROM moat.peer_baselines "
                "WHERE detector_id = $1 AND segment = $2",
                SEG_DETECTOR,
                "gmv:mid",
            )
            # With the 100000 extreme present, p75 is pulled well above 400.
            assert Decimal(pre["p75"]) > Decimal("400")

            # Purge the extreme shop -> band stays at 5 contributors.
            await purge_shop_contributions(conn, pseudonyms[0], pepper=PEPPER, run_date=date.today())

            row = await conn.fetchrow(
                "SELECT n, p25, p50, p75 FROM moat.peer_baselines "
                "WHERE detector_id = $1 AND segment = $2",
                SEG_DETECTOR,
                "gmv:mid",
            )
            assert row is not None
            assert int(row["n"]) == 5
            # The remaining five are 100/200/300/400/500 -> the quartiles no
            # longer reflect the withdrawn 100000 extreme.
            assert Decimal(row["p25"]) == Decimal("200")
            assert Decimal(row["p50"]) == Decimal("300")
            assert Decimal(row["p75"]) == Decimal("400")
        finally:
            await _cleanup_segmented(conn)
