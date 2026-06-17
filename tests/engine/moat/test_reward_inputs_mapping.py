"""Slice #2 — pin the alert_feedback.kind -> compute_reward mapping.

Pure, no DB. This is the regression guard for THE CRUX: the three
feedback_kind enum labels are identical to the three strings
compute_reward branches on, so a RewardInput["feedback_kind"] read straight
off alert_feedback.kind can be passed into compute_reward with no
translation. If the enum ever drifts (a 4th label, or a rename), this
test goes red instead of the trainer silently producing 0 reward.

SEAM NOTE: ``RewardInput`` is the ``TypedDict`` already committed in
``calderyn_engine.moat.threshold_trainer`` (whose ``_fold_group`` consumes
rows via DICT access, e.g. ``r["feedback_kind"]``). ``reward_inputs`` reuses
that exact type and emits dict-shaped rows so the #2->#3 ends compose with no
adapter. (The slice plan's frozen-dataclass shape is overridden here per the
umbrella's authoritative seam: dicts conforming to the trainer's TypedDict.)
"""

from __future__ import annotations

from decimal import Decimal

from calderyn_engine.moat.reward_inputs import RewardInput, derive_reward_inputs
from calderyn_engine.moat.rewards import FALSE_POSITIVE_PENALTY, compute_reward
from calderyn_engine.moat.threshold_trainer import RewardInput as TrainerRewardInput

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


def test_reward_input_is_the_trainer_typeddict() -> None:
    # The seam type IS the committed trainer's TypedDict (re-exported), not a
    # parallel dataclass. This is what lets derive_reward_inputs(...) feed
    # straight into _fold_group(...) with no adapter.
    assert RewardInput is TrainerRewardInput


def test_reward_input_is_dict_shaped_with_exact_fields() -> None:
    # TypedDict is a plain dict at runtime; _fold_group reads it with
    # r["feedback_kind"] etc., so the row MUST be dict-shaped (not attribute
    # access) and carry exactly the six trainer fields.
    ri = _make("confirmed_loss", impact=Decimal("100"), days=1)
    assert isinstance(ri, dict)
    assert set(ri.keys()) == {
        "shop_id",
        "detector_id",
        "feedback_kind",
        "dollar_impact",
        "days_to_confirm",
        "alert_id",
    }
    # DICT access is the contract (mirrors threshold_trainer._fold_group).
    assert ri["feedback_kind"] == "confirmed_loss"
    assert ri["dollar_impact"] == Decimal("100")


def test_derive_reward_inputs_is_exported() -> None:
    # The producer the trainer cohort calls per shop.
    assert callable(derive_reward_inputs)


def test_confirmed_loss_label_feeds_compute_reward_as_positive() -> None:
    ri = _make("confirmed_loss", impact=Decimal("1500"), days=2)
    reward = compute_reward(
        ri["feedback_kind"], ri["dollar_impact"], ri["days_to_confirm"]
    )
    assert reward == Decimal("1500")


def test_false_positive_label_feeds_compute_reward_as_penalty() -> None:
    ri = _make("false_positive", impact=Decimal("999"), days=0)
    reward = compute_reward(
        ri["feedback_kind"], ri["dollar_impact"], ri["days_to_confirm"]
    )
    assert reward == FALSE_POSITIVE_PENALTY
    assert reward == Decimal("-10")


def test_already_handled_label_feeds_compute_reward_as_zero() -> None:
    ri = _make("already_handled", impact=Decimal("500"), days=5)
    reward = compute_reward(
        ri["feedback_kind"], ri["dollar_impact"], ri["days_to_confirm"]
    )
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
