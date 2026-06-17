"""Slice #3 (cohort) — DB-backed coverage of the top-level nightly trainer.

Exercises ``train_thresholds(conn, *, pepper, run_date)`` — the cohort
enumeration + cold-start pass that the umbrella §9.3 pins as authoritative
(the trainer enumerates the cohort itself, rather than taking injected
reward/segment callables as the original slice plan sketched).

Cohort rule (umbrella §4.2 + task): every shop with
``peer_data_consent = true`` OR with any ``alert_feedback`` row. A
consenting shop with no feedback still gets a cold-start model row seeded
from the peer baseline (== peer median); a NON-consenting shop with no
feedback is never trained.

Uses the pg_pool fixture (skips unless TEST_DATABASE_URL is a local DB).
"""
from __future__ import annotations

import json
import uuid
from datetime import date
from decimal import Decimal

import pytest

import calderyn_engine.moat.threshold_trainer as tt
from calderyn_engine.moat.pseudonym import pseudonym_for
from calderyn_engine.moat.threshold_trainer import train_thresholds

PEPPER = "pepper-cohort-db"
DETECTOR = "sku_stockout_vs_spend"
KEY = "min_spend_usd"
# Shops seeded here have no order_fact rows, so gmv_band_for_shop resolves
# them all to the floor band. Seed the baseline under that same band so the
# prior the trainer reads matches what the cohort resolves to.
SEGMENT = "gmv:micro"
RUN_DATE = date(2026, 6, 17)


def _tj(value):
    """asyncpg jsonb may come back as str or dict; normalise to dict."""
    return json.loads(value) if isinstance(value, str) else value


async def _seed_baseline(conn, detector, p25, p50, p75, n) -> None:
    await conn.execute(
        "DELETE FROM moat.peer_baselines WHERE detector_id = $1 AND segment = $2",
        detector,
        SEGMENT,
    )
    await conn.execute(
        "INSERT INTO moat.peer_baselines "
        "(detector_id, segment, p25, p50, p75, n, computed_at) "
        "VALUES ($1,$2,$3,$4,$5,$6, now())",
        detector,
        SEGMENT,
        Decimal(str(p25)),
        Decimal(str(p50)),
        Decimal(str(p75)),
        n,
    )


async def _seed_shop(conn, shop_id: str, *, consent: bool) -> None:
    suffix = shop_id.replace("-", "")[-12:]
    await conn.execute(
        "INSERT INTO public.shops (id, shop_domain, peer_data_consent) "
        "VALUES ($1, $2, $3) "
        "ON CONFLICT (id) DO UPDATE SET peer_data_consent = EXCLUDED.peer_data_consent",
        shop_id,
        f"cohort-{suffix}.myshopify.com",
        consent,
    )


async def _seed_alert_with_feedback(
    conn, shop_id: str, detector: str, kind: str, *, dollar_impact: int
) -> str:
    alert_id = str(uuid.uuid4())
    await conn.execute(
        "INSERT INTO public.alerts "
        "(id, shop_id, detector_id, entity_ref, dollar_impact, day_bucket) "
        "VALUES ($1, $2, $3, '{}'::jsonb, $4, $5)",
        alert_id,
        shop_id,
        detector,
        dollar_impact,
        RUN_DATE,
    )
    await conn.execute(
        "INSERT INTO public.alert_feedback (alert_id, shop_id, kind) "
        "VALUES ($1, $2, $3::feedback_kind)",
        alert_id,
        shop_id,
        kind,
    )
    return alert_id


@pytest.mark.asyncio
async def test_cohort_consent_feedback_coldstart_and_nonconsent(pg_pool) -> None:
    """THE COHORT PROOF (task cohort criteria).

    - consenting shop WITH a confirmed_loss => trained, posterior moved
      below the peer consensus (alpha>beta, threshold < p50).
    - consenting shop with NO feedback => cold-start row == peer median (p50).
    - NON-consenting shop with NO feedback => NOT trained (no row written).
    """
    async with pg_pool.acquire() as conn:
        await _seed_baseline(conn, DETECTOR, 200, 300, 400, 5)

        consent_fb = str(uuid.uuid4())
        consent_nofb = str(uuid.uuid4())
        noconsent_nofb = str(uuid.uuid4())
        await _seed_shop(conn, consent_fb, consent=True)
        await _seed_shop(conn, consent_nofb, consent=True)
        await _seed_shop(conn, noconsent_nofb, consent=False)

        await _seed_alert_with_feedback(
            conn, consent_fb, DETECTOR, "confirmed_loss", dollar_impact=50
        )

        summary = await train_thresholds(conn, pepper=PEPPER, run_date=RUN_DATE)

        # No failures. shops_trained counts at least our two consenting shops;
        # other test files in the same (session-scoped) DB may seed additional
        # cohort shops, so assert >= rather than an exact global count. The
        # per-shop row assertions below are the real behavioural checks.
        assert summary["errors"] == []
        assert summary["skipped"] == 0
        assert summary["shops_trained"] >= 2  # consent_fb + consent_nofb

        fb_pseud = pseudonym_for(consent_fb, PEPPER)
        nofb_pseud = pseudonym_for(consent_nofb, PEPPER)
        noc_pseud = pseudonym_for(noconsent_nofb, PEPPER)

        fb_row = await conn.fetchrow(
            "SELECT threshold_json, posterior_json FROM moat.detection_models "
            "WHERE detector_id = $1 AND shop_id_pseudonym = $2",
            DETECTOR,
            fb_pseud,
        )
        nofb_row = await conn.fetchrow(
            "SELECT threshold_json, posterior_json FROM moat.detection_models "
            "WHERE detector_id = $1 AND shop_id_pseudonym = $2",
            DETECTOR,
            nofb_pseud,
        )
        noc_row = await conn.fetchrow(
            "SELECT 1 FROM moat.detection_models "
            "WHERE detector_id = $1 AND shop_id_pseudonym = $2",
            DETECTOR,
            noc_pseud,
        )

        # Feedback shop: moved off consensus toward its own willingness to act.
        fb_tj = _tj(fb_row["threshold_json"])
        fb_pj = _tj(fb_row["posterior_json"])
        assert fb_pj["alpha"] > fb_pj["beta"]
        assert fb_pj["seeded_from"] == "peer_baseline"
        assert fb_tj[KEY] < 300.0

        # Cold-start shop: inherits the peer consensus EXACTLY (== p50).
        nofb_tj = _tj(nofb_row["threshold_json"])
        nofb_pj = _tj(nofb_row["posterior_json"])
        assert nofb_tj[KEY] == 300.0
        assert nofb_pj["n_events"] == 0
        assert nofb_pj["seeded_from"] == "peer_baseline"

        # Moat effect observable: feedback pulled the threshold below cold-start.
        assert fb_tj[KEY] < nofb_tj[KEY]

        # Non-consenting + no feedback: never enumerated, no row.
        assert noc_row is None


@pytest.mark.asyncio
async def test_cohort_per_group_error_is_counted_not_fatal(
    pg_pool, monkeypatch
) -> None:
    """Fail-visible (rule 12): one shop's per-detector failure is recorded in
    ``errors``/``skipped`` and does NOT abort training for the other shop."""
    async with pg_pool.acquire() as conn:
        await _seed_baseline(conn, DETECTOR, 200, 300, 400, 5)

        good_shop = str(uuid.uuid4())
        bad_shop = str(uuid.uuid4())
        await _seed_shop(conn, good_shop, consent=True)
        await _seed_shop(conn, bad_shop, consent=True)
        await _seed_alert_with_feedback(
            conn, good_shop, DETECTOR, "confirmed_loss", dollar_impact=50
        )
        await _seed_alert_with_feedback(
            conn, bad_shop, DETECTOR, "confirmed_loss", dollar_impact=50
        )

        # Inject a deterministic failure for exactly the bad shop's reward read.
        # ``derive_reward_inputs`` is a lazily-bound module attribute on the
        # trainer (it starts as None to break an import cycle), so import the
        # real producer directly for the passthrough rather than reading the
        # sentinel.
        from calderyn_engine.moat.reward_inputs import derive_reward_inputs

        async def flaky_derive(conn_, shop_id, *, since=None):
            if shop_id == bad_shop:
                raise RuntimeError("boom: synthetic reward-read failure")
            return await derive_reward_inputs(conn_, shop_id, since=since)

        monkeypatch.setattr(tt, "derive_reward_inputs", flaky_derive)

        summary = await train_thresholds(conn, pepper=PEPPER, run_date=RUN_DATE)

        # The bad shop is counted, never raised; the good shop still trained.
        assert summary["skipped"] >= 1
        assert any(bad_shop in e for e in summary["errors"])
        assert summary["shops_trained"] >= 1

        good_row = await conn.fetchrow(
            "SELECT 1 FROM moat.detection_models "
            "WHERE detector_id = $1 AND shop_id_pseudonym = $2",
            DETECTOR,
            pseudonym_for(good_shop, PEPPER),
        )
        assert good_row is not None
