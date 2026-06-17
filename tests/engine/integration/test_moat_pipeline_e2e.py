"""Phase B capstone — the ASSEMBLED moat pipeline runs end-to-end on one cohort.

No mocks. Seeds 5 consenting shops in one GMV band, each with a confirmed loss,
then runs the REAL nightly job (`run_peer_incident_etl` -> `train_thresholds`)
and proves the moat formed from anonymized cross-tenant data:
  * a k>=5 peer baseline exists for (detector, segment),
  * every shop gets a peer-informed `detection_models` row keyed by pseudonym (A4),
  * `get_threshold` reads back a LEARNED value (not the static $500 default).

This exercises slices #2 (reward derivation) + #3 (cohort train) + #5 (ETL,
segments, baselines) + the consume path together — the one seam (real ETL
output feeding real training via the SAME gmv segment) that the per-slice
unit tests never run end-to-end. Self-cleaning so it stays hermetic in the
shared session test DB.
"""
from __future__ import annotations

import json
import uuid
from datetime import date
from decimal import Decimal

import pytest

from calderyn_engine.moat.peer_incident_etl import run_peer_incident_etl
from calderyn_engine.moat.pseudonym import pseudonym_for
from calderyn_engine.moat.threshold_trainer import train_thresholds
from calderyn_engine.thresholds import get_threshold

PEPPER = "pepper-e2e-capstone"
DETECTOR = "margin_erosion"   # dollar-gated; canonical key min_impact_usd; $500 default
KEY = "min_impact_usd"
SEGMENT = "gmv:small"         # $10k–$50k trailing-90d band


async def _seed_shop(conn, shop_id, *, consent):
    await conn.execute(
        "INSERT INTO public.shops (id, shop_domain, peer_data_consent) "
        "VALUES ($1::uuid, $2, $3) "
        "ON CONFLICT (id) DO UPDATE SET peer_data_consent = EXCLUDED.peer_data_consent",
        shop_id, f"e2e-{shop_id[:8]}.myshopify.com", consent,
    )


async def _seed_order(conn, shop_id, *, total_cents, days_ago):
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


async def _seed_alert(conn, shop_id, *, day, dollar_impact, detector):
    alert_id = str(uuid.uuid4())
    entity_ref = json.dumps({"ref": alert_id})  # unique per alert (unique constraint)
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


async def _seed_confirmed_loss(conn, shop_id, alert_id, *, when_day):
    await conn.execute(
        """
        INSERT INTO public.alert_feedback
          (id, alert_id, shop_id, kind, note, created_by, created_at)
        VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'confirmed_loss',
                'e2e', 'tester', ($3::date + interval '6 hours'))
        """,
        alert_id, shop_id, when_day,
    )


@pytest.mark.asyncio
async def test_moat_pipeline_runs_end_to_end(pg_pool) -> None:
    day = date.today()
    shop_ids = [str(uuid.uuid4()) for _ in range(5)]
    pseudonyms = [pseudonym_for(s, PEPPER) for s in shop_ids]
    impacts = [Decimal(x) for x in (100, 200, 300, 400, 500)]  # spread -> real quartiles

    async with pg_pool.acquire() as conn:
        try:
            # Seed a consenting cohort in one GMV band, each with a confirmed loss.
            for shop_id, impact in zip(shop_ids, impacts):
                await _seed_shop(conn, shop_id, consent=True)
                await _seed_order(conn, shop_id, total_cents=2_000_000, days_ago=10)  # $20k -> small
                alert_id = await _seed_alert(
                    conn, shop_id, day=day, dollar_impact=impact, detector=DETECTOR
                )
                await _seed_confirmed_loss(conn, shop_id, alert_id, when_day=day)

            # RUN THE REAL ASSEMBLED PIPELINE (no mocks): ETL then train.
            await run_peer_incident_etl(conn, run_date=day, pepper=PEPPER)
            await train_thresholds(conn, pepper=PEPPER, run_date=day)

            # The moat formed from anonymized cross-tenant data (k>=5 floor met).
            baseline = await conn.fetchrow(
                "SELECT p25, p50, p75, n FROM moat.peer_baselines "
                "WHERE detector_id=$1 AND segment=$2",
                DETECTOR, SEGMENT,
            )
            assert baseline is not None, "no peer baseline — ETL or segment seam broke"
            assert baseline["n"] >= 5                       # k-anonymity floor satisfied
            assert baseline["p25"] < baseline["p75"]        # genuine spread across peers

            # Every shop got a peer-informed model row, keyed by pseudonym (A4 — never raw shop_id).
            model_rows = await conn.fetch(
                "SELECT shop_id_pseudonym, threshold_json FROM moat.detection_models "
                "WHERE detector_id=$1 AND shop_id_pseudonym = ANY($2::text[])",
                DETECTOR, pseudonyms,
            )
            assert len(model_rows) == 5
            for r in model_rows:
                assert r["shop_id_pseudonym"].startswith("p_")

            # The loop closes: get_threshold returns the LEARNED value, not the static $500.
            learned = await get_threshold(conn, shop_ids[0], DETECTOR, pepper=PEPPER)
            assert learned != Decimal("500"), "still the static default — train/consume seam broke"
            assert Decimal("0") < learned <= baseline["p75"] * 3
        finally:
            # Hermetic cleanup (shared session DB).
            await conn.execute(
                "DELETE FROM moat.detection_models WHERE shop_id_pseudonym = ANY($1::text[])",
                pseudonyms,
            )
            await conn.execute(
                "DELETE FROM moat.event_log WHERE pseudonym_id = ANY($1::text[])", pseudonyms
            )
            await conn.execute(
                "DELETE FROM moat.peer_baselines WHERE detector_id=$1 AND segment=$2",
                DETECTOR, SEGMENT,
            )
            await conn.execute(
                "DELETE FROM moat_keys.shop_pseudonym WHERE shop_id = ANY($1::uuid[])", shop_ids
            )
            await conn.execute(
                "DELETE FROM public.order_fact WHERE shop_id = ANY($1::uuid[])", shop_ids
            )
            await conn.execute(
                "DELETE FROM public.shops WHERE id = ANY($1::uuid[])", shop_ids
            )  # cascades alerts/alert_feedback/alert_context
