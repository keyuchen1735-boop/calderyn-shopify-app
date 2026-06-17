"""Slice #2 — per-(shop, detector) reward-input read layer.

``derive_reward_inputs`` joins ``public.alerts`` to ``public.alert_feedback``
and yields one :data:`RewardInput` per feedback row — exactly the fields the
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
and is intentionally not read here (umbrella §9, spec §5); the row carries
``alert_id`` so a future secondary signal can join it back additively.

SEAM (the #2->#3 contract): the row type is the ``RewardInput`` ``TypedDict``
already committed in :mod:`calderyn_engine.moat.threshold_trainer`, re-exported
here. The trainer's ``_fold_group`` consumes these rows via DICT access
(``r["feedback_kind"]``), so this producer emits plain dicts conforming to that
``TypedDict`` — the ends compose with no adapter. (The slice plan/spec sketched
a frozen dataclass; this module OVERRIDES that per the umbrella's authoritative
seam so DICT-access consumption keeps working.) Importing ``RewardInput`` from
the trainer is safe: the trainer does not import this module, so there is no
import cycle.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any

import structlog

# Re-export the committed seam type. RewardInput is a TypedDict (a plain dict at
# runtime); threshold_trainer._fold_group reads rows of this shape by key.
from calderyn_engine.moat.threshold_trainer import RewardInput

__all__ = ["RewardInput", "derive_reward_inputs"]

logger = structlog.get_logger()


def _days_to_confirm(first_seen_at: datetime, feedback_at: datetime) -> int:
    """Whole days between alert first-seen and feedback, floored, clamped >= 0.

    ``int(delta.total_seconds() // 86400)`` floors to whole days (47h -> 1);
    ``max(..., 0)`` clamps the clock-skew/backfill case (feedback older than its
    alert) to 0 so the trainer never sees a negative age. Computed in Python so
    the arithmetic matches the test fixtures exactly and avoids Postgres
    ``interval``/``extract`` rounding surprises.
    """

    delta = feedback_at - first_seen_at
    return max(int(delta.total_seconds() // 86400), 0)


async def derive_reward_inputs(
    conn: Any,
    shop_id: str,
    *,
    since: datetime | None = None,
) -> list[RewardInput]:
    """Yield one :data:`RewardInput` per alert_feedback row for ``shop_id``.

    Parameters
    ----------
    conn:
        asyncpg connection. The caller owns transaction scope; this function
        only SELECTs and does not BEGIN/COMMIT (mirrors ``compute_peer_baselines``
        taking a bare ``conn``).
    shop_id:
        Tenant uuid (string form). Scopes the read to this shop's own alerts.
    since:
        Optional inclusive lower bound on ``alert_feedback.created_at`` so the
        nightly trainer can process only feedback newer than its last run.
        ``None`` (default) returns full history.

    Returns
    -------
    list[RewardInput]
        One dict row per feedback, ordered by feedback time ascending. Each row
        matches the committed ``RewardInput`` ``TypedDict`` and is safe to pass
        straight into ``threshold_trainer._fold_group`` / ``compute_reward``.
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

    inputs: list[RewardInput] = [
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
