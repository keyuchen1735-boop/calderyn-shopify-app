"""SKU/variant/location-scoped reward kernels for the Phase-2 graduatable actions
(design 2026-06-26 §5b). Same sign convention as compute_action_reward: positive =
helped, undo = -100 hard negative. No I/O.

Unit economics are in cents per unit (margin minus attributable CAC), the same
quantity negative_unit_economics.py computes. Profit/bleed are scaled to dollars.
"""
from __future__ import annotations
from decimal import Decimal

UNDO_PENALTY: Decimal = Decimal("-100")


def compute_sku_action_reward(
    action_kind: str,
    pre_unit_econ_cents: int,
    post_unit_econ_cents: int,
    units: int,
    undone: bool,
) -> Decimal:
    if undone:
        return UNDO_PENALTY
    if action_kind == "discontinue_sku":
        # Credit the per-unit bleed we stopped; if the SKU was profitable, -pre is
        # negative and this is the margin we destroyed. Sign handles both cases.
        return Decimal(-pre_unit_econ_cents) * units / 100
    if action_kind == "adjust_price":
        # Profit delta per unit * units sold in the post window.
        return Decimal(post_unit_econ_cents - pre_unit_econ_cents) * units / 100
    return Decimal("0")


def compute_inventory_reward(
    units_sold_dest_post: int,
    unit_margin_cents: int,
    source_stockout_units: int,
    undone: bool,
) -> Decimal:
    if undone:
        return UNDO_PENALTY
    # Margin captured by selling relocated stock at the destination, net of any
    # sales lost because the source ran short after the move.
    gained = Decimal(units_sold_dest_post) * unit_margin_cents / 100
    lost = Decimal(source_stockout_units) * unit_margin_cents / 100
    return gained - lost
