# Task 16 data-availability spike findings (recorded per brief Step 0).
#
# All three SKU/variant/location-scoped action kinds carry the fields the reward
# derivation needs in action_audit.params. Confirmed against the WRITE paths
# (authoritative — the merchant undo reader in undo.server.ts assumes a subset):
#
#   discontinue_sku  -> params: sku, sku_id, product_id, archived_status
#     (app/lib/actions/alert-action.server.ts executeDiscontinueAlertAction, ~L230)
#   adjust_price     -> params: sku, sku_id, variant_id, product_id,
#                       prior_price_cents, new_price_cents
#     (app/lib/actions/adjust-price.server.ts, ~L212)
#   reallocate_inventory -> params: sku, sku_id, inventory_item_id,
#                       from_location_id, to_location_id, delta
#     (app/lib/actions/inventory-relocate.server.ts ~L153 and
#      app/lib/actions/alert-action.server.ts ~L113 — identical shape)
#
# So `params->>'sku_id'` resolves for ALL three kinds. `delta` is present only on
# reallocate_inventory (NULL for the other two; we never read it on those paths).
#
# Plan-SQL CORRECTIONS made during the spike:
#  - to_location_id in params is the Shopify EXTERNAL location GID, NOT
#    location_dim.id (inventory-relocate.server.ts InventoryRelocationInput:
#    "Shopify Location GIDs (location_dim.external_id)"). The reallocate reward
#    therefore does NOT join inventory by destination location id — it reads
#    SKU-wide unit economics over the post window (the v1 simplification already
#    documented in the brief), so the external/internal id mismatch never bites.
#  - The brief's `(a.params->>'delta')::int` is kept but only consumed for
#    reallocate_inventory; selecting it for the other kinds yields NULL safely.
#
# order economics columns confirmed:
#  - order_line_fact(sku_id, quantity, price_cents, total_cents,
#    unit_cost_cents_snapshot, order_id, shop_id) and
#    order_fact(id, shop_id, created_at_source)
#    (tests/engine/schema/migrations/20260426000003_orders_and_fulfillments.sql).
#    The unit-margin formula and the order_line_fact ⨝ order_fact join mirror
#    detectors/negative_unit_economics.py (created_at_source confirmed as the
#    window-date column on order_fact).
#  - inventory_level_fact(sku_id, location_id, available, observed_at) confirmed
#    (tests/engine/schema/migrations/20260426000002_inventory_and_location.sql) —
#    available for a future stockout-attribution refinement, not the v1 metric.
#
# action_audit columns confirmed: id, shop_id, alert_id, action_kind, params,
# outcome, actor_user_id, undo_of, created_at
# (tests/engine/schema/migrations/20260430000022_action_audit_and_undo.sql).
from decimal import Decimal

from calderyn_engine.moat.sku_action_rewards import (
    compute_sku_action_reward,
    compute_inventory_reward,
)


def test_discontinue_credits_averted_bleed():
    # SKU was net -$3/unit over 200 units; discontinuing stops that bleed.
    r = compute_sku_action_reward("discontinue_sku", -300, 0, 200, False)
    assert r == Decimal("600")  # 200 units * $3 averted


def test_discontinue_penalizes_killing_a_profitable_sku():
    r = compute_sku_action_reward("discontinue_sku", 150, 0, 200, False)
    assert r < 0  # it was profitable; killing it was wrong


def test_adjust_price_credits_profit_improvement():
    # Per-unit economics rose from $5 to $8 over 100 units -> +$300.
    r = compute_sku_action_reward("adjust_price", 500, 800, 100, False)
    assert r == Decimal("300")


def test_inventory_reward_credits_dest_sales_net_of_source_stockout():
    # 40 units sold at dest * $5 margin - 10 source-stockout units * $5 = $150.
    r = compute_inventory_reward(40, 500, 10, False)
    assert r == Decimal("150")


def test_sku_undo_is_hard_negative():
    assert compute_sku_action_reward("adjust_price", 500, 800, 100, True) == Decimal("-100")
    assert compute_inventory_reward(40, 500, 10, True) == Decimal("-100")
