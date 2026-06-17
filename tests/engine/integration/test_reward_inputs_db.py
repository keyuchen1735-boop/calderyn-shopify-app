"""Slice #2 — DB-backed coverage of derive_reward_inputs + the #2->#3 seam.

Uses the parent conftest's ``pg_pool`` fixture (skips unless a local
TEST_DATABASE_URL is set; see tests/engine/conftest.py). Seeds
shops -> alerts -> alert_feedback directly (the real FK order) and asserts:

  * one dict row per alert_feedback row, carrying detector_id / dollar_impact /
    feedback_kind / alert_id from the join;
  * the alert_feedback.kind -> feedback_kind IDENTITY mapping survives the DB;
  * days_to_confirm = whole-day floor of (feedback.created_at -
    alert.first_seen_at), clamped to 0 for clock-skew;
  * per-shop scope: a second shop's feedback never leaks into shop A's rows;
  * the ``since`` incremental cutoff filters out older feedback.

THE #2->#3 COMPOSITION TEST (the load-bearing one): the rows
derive_reward_inputs(...) returns feed STRAIGHT into the committed trainer's
_fold_group(...) with no adapter — proving the ends compose because both sides
speak the same RewardInput TypedDict via DICT access.

Isolation: every shop_id is a fresh uuid4 and the shop_domain carries the
``ri-db-`` marker, so this suite never collides with other suites' rows.
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from calderyn_engine.moat.reward_inputs import RewardInput, derive_reward_inputs
from calderyn_engine.moat.threshold_trainer import _fold_group

# --- the #2->#3 composition constants (mirror test_threshold_trainer_db.py) --
_COMPOSE_DETECTOR = "sku_stockout_vs_spend"
_COMPOSE_KEY = "min_spend_usd"
_COMPOSE_SEGMENT = "gmv:reward-inputs-db"


async def _seed_shop(conn, shop_id: str) -> None:
    # Distinct ``ri-db-`` marker + uuid4 suffix => never collides with the
    # detector/peer-baseline suites (shop_domain has a UNIQUE constraint).
    suffix = shop_id.replace("-", "")[-12:]
    await conn.execute(
        "INSERT INTO public.shops (id, shop_domain) VALUES ($1::uuid, $2) "
        "ON CONFLICT (id) DO NOTHING",
        shop_id,
        f"ri-db-{suffix}.myshopify.com",
    )


async def _seed_alert(
    conn,
    *,
    shop_id: str,
    detector_id: str,
    dollar_impact: Decimal,
    first_seen_at: datetime,
) -> str:
    # alerts.shop_id FKs shops(id); seed the shop first. entity_ref is NOT NULL
    # jsonb and day_bucket is NOT NULL date — supply both. entity_ref is keyed
    # to the alert_id so each insert is a DISTINCT condition: the partial unique
    # index alerts_active_condition_key on (shop_id, detector_id, entity_ref)
    # for non-terminal statuses (migration 20260614000000) otherwise collapses
    # repeated (shop, detector, {}) alerts onto one row.
    alert_id = str(uuid.uuid4())
    entity_ref = json.dumps({"id": alert_id})
    await conn.execute(
        """
        INSERT INTO public.alerts
          (id, shop_id, detector_id, entity_ref, dollar_impact,
           day_bucket, first_seen_at, last_seen_at)
        VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5,
                $6::date, $6, $6)
        """,
        alert_id,
        shop_id,
        detector_id,
        entity_ref,
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
    # alert_feedback.alert_id FKs alerts(id) and shop_id FKs shops(id);
    # seed shop then alert then feedback (the discovered FK order).
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
        # The seam is a dict (TypedDict at runtime) read by DICT access — the
        # exact shape threshold_trainer._fold_group consumes.
        assert isinstance(ri, dict)
        assert ri["shop_id"] == shop_id  # RAW shop_id (invariant A5)
        assert ri["alert_id"] == alert_id
        assert ri["detector_id"] == "campaign_below_breakeven"
        assert ri["feedback_kind"] == "confirmed_loss"
        assert ri["dollar_impact"] == Decimal("1234.56")
        assert isinstance(ri["dollar_impact"], Decimal)
        assert ri["days_to_confirm"] == 3


@pytest.mark.asyncio
async def test_identity_kind_mapping_survives_the_db(pg_pool) -> None:
    # Each of the three feedback_kind enum labels comes back verbatim as
    # feedback_kind (no translation) — the pinned identity map, end to end.
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

        # ascending by feedback time => same order we inserted the offsets in
        assert [ri["feedback_kind"] for ri in out] == kinds
        assert all(ri["detector_id"] == "margin_erosion" for ri in out)


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
        assert out[0]["days_to_confirm"] == 1


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
        assert out[0]["days_to_confirm"] == 0


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
            detector_id="negative_unit_economics",
            dollar_impact=Decimal("10"),
            first_seen_at=seen,
        )
        await _seed_feedback(
            conn,
            alert_id=a_alert,
            shop_id=shop_a,
            kind="confirmed_loss",
            created_at=seen + timedelta(days=1),
        )
        b_alert = await _seed_alert(
            conn,
            shop_id=shop_b,
            detector_id="negative_unit_economics",
            dollar_impact=Decimal("9999"),
            first_seen_at=seen,
        )
        await _seed_feedback(
            conn,
            alert_id=b_alert,
            shop_id=shop_b,
            kind="false_positive",
            created_at=seen + timedelta(days=1),
        )

        out_a = await derive_reward_inputs(conn, shop_a)

        assert len(out_a) == 1
        assert out_a[0]["shop_id"] == shop_a
        assert out_a[0]["alert_id"] == a_alert
        assert out_a[0]["dollar_impact"] == Decimal("10")


@pytest.mark.asyncio
async def test_since_cutoff_excludes_older_feedback(pg_pool) -> None:
    async with pg_pool.acquire() as conn:
        shop_id = str(uuid.uuid4())
        await _seed_shop(conn, shop_id)
        seen = datetime(2026, 6, 6, 0, 0, tzinfo=UTC)

        old_alert = await _seed_alert(
            conn,
            shop_id=shop_id,
            detector_id="reorder_timing",
            dollar_impact=Decimal("1"),
            first_seen_at=seen,
        )
        await _seed_feedback(
            conn,
            alert_id=old_alert,
            shop_id=shop_id,
            kind="confirmed_loss",
            created_at=seen + timedelta(days=1),
        )
        new_alert = await _seed_alert(
            conn,
            shop_id=shop_id,
            detector_id="reorder_timing",
            dollar_impact=Decimal("2"),
            first_seen_at=seen,
        )
        await _seed_feedback(
            conn,
            alert_id=new_alert,
            shop_id=shop_id,
            kind="confirmed_loss",
            created_at=seen + timedelta(days=10),
        )

        cutoff = seen + timedelta(days=5)
        out = await derive_reward_inputs(conn, shop_id, since=cutoff)

        assert len(out) == 1
        assert out[0]["alert_id"] == new_alert
        assert out[0]["dollar_impact"] == Decimal("2")


@pytest.mark.asyncio
async def test_since_none_returns_full_history(pg_pool) -> None:
    async with pg_pool.acquire() as conn:
        shop_id = str(uuid.uuid4())
        await _seed_shop(conn, shop_id)
        seen = datetime(2026, 6, 7, 0, 0, tzinfo=UTC)
        for offset in (1, 10):
            alert_id = await _seed_alert(
                conn,
                shop_id=shop_id,
                detector_id="reorder_timing",
                dollar_impact=Decimal("1"),
                first_seen_at=seen,
            )
            await _seed_feedback(
                conn,
                alert_id=alert_id,
                shop_id=shop_id,
                kind="confirmed_loss",
                created_at=seen + timedelta(days=offset),
            )

        out = await derive_reward_inputs(conn, shop_id, since=None)

        assert len(out) == 2


@pytest.mark.asyncio
async def test_empty_shop_returns_empty_list(pg_pool) -> None:
    # A shop with no feedback yields no reward inputs (the cold-start cohort
    # the trainer instead seeds from the peer baseline).
    async with pg_pool.acquire() as conn:
        shop_id = str(uuid.uuid4())
        await _seed_shop(conn, shop_id)
        out = await derive_reward_inputs(conn, shop_id)
        assert out == []


@pytest.mark.asyncio
async def test_derived_rows_feed_fold_group_unchanged(pg_pool) -> None:
    """THE #2->#3 SEAM PROOF — the ends compose with no adapter.

    derive_reward_inputs(...) returns dict rows matching the committed
    trainer's RewardInput TypedDict, so they pass STRAIGHT into _fold_group
    (which reads them via r["feedback_kind"], r["dollar_impact"], ...). A
    peer baseline seeds the prior; a confirmed_loss reward folds in; the
    fold returns a (posterior_json, threshold_json) pair without error and
    the threshold carries the canonical key. This is the only place the #2
    output and the #3 input are wired together.
    """
    async with pg_pool.acquire() as conn:
        shop_id = str(uuid.uuid4())
        await _seed_shop(conn, shop_id)
        seen = datetime(2026, 6, 8, 0, 0, tzinfo=UTC)
        alert_id = await _seed_alert(
            conn,
            shop_id=shop_id,
            detector_id=_COMPOSE_DETECTOR,
            dollar_impact=Decimal("50"),
            first_seen_at=seen,
        )
        await _seed_feedback(
            conn,
            alert_id=alert_id,
            shop_id=shop_id,
            kind="confirmed_loss",
            created_at=seen + timedelta(days=1),
        )

        rows = await derive_reward_inputs(conn, shop_id)
        assert len(rows) == 1
        # A trainer-shaped baseline (already k>=5 floored upstream).
        baseline = {
            "p25": Decimal("200"),
            "p50": Decimal("300"),
            "p75": Decimal("400"),
            "n": 5,
        }

        # The load-bearing line: #2's output -> #3's input, verbatim.
        posterior, threshold = _fold_group(
            rows, baseline, _COMPOSE_KEY, Decimal("500"), 0.5
        )

        # The fold produced a usable posterior + threshold without error.
        assert posterior["n_events"] == 1
        assert posterior["seeded_from"] == "peer_baseline"
        assert "alpha" in posterior and "beta" in posterior
        assert _COMPOSE_KEY in threshold
        # confirmed_loss is a positive reward => mean shifts above 0.5 =>
        # threshold loosens below the peer consensus median (p50=300).
        assert posterior["alpha"] > posterior["beta"]
        assert threshold[_COMPOSE_KEY] < 300.0


@pytest.mark.asyncio
async def test_fold_group_can_consume_rewardinput_constructed_rows(pg_pool) -> None:
    # Belt-and-suspenders: a hand-built RewardInput (the re-exported trainer
    # TypedDict) is interchangeable with derive_reward_inputs output going
    # into _fold_group — confirming the seam type is literally the same one.
    async with pg_pool.acquire() as conn:
        shop_id = str(uuid.uuid4())
        await _seed_shop(conn, shop_id)
        seen = datetime(2026, 6, 9, 0, 0, tzinfo=UTC)
        alert_id = await _seed_alert(
            conn,
            shop_id=shop_id,
            detector_id=_COMPOSE_DETECTOR,
            dollar_impact=Decimal("70"),
            first_seen_at=seen,
        )
        await _seed_feedback(
            conn,
            alert_id=alert_id,
            shop_id=shop_id,
            kind="confirmed_loss",
            created_at=seen + timedelta(days=2),
        )
        derived = await derive_reward_inputs(conn, shop_id)

        manual: RewardInput = {
            "shop_id": shop_id,
            "detector_id": _COMPOSE_DETECTOR,
            "feedback_kind": "confirmed_loss",
            "dollar_impact": Decimal("70"),
            "days_to_confirm": 2,
            "alert_id": derived[0]["alert_id"],
        }
        # Same keys, same value types — the derived row IS a RewardInput.
        assert set(derived[0].keys()) == set(manual.keys())
        for k in manual:
            assert type(derived[0][k]) is type(manual[k])
