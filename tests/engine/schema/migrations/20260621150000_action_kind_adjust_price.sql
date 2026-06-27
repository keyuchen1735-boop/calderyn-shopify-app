-- supabase/migrations/20260621150000_action_kind_adjust_price.sql
-- Register adjust_price so the engine schema can store + reward SKU price
-- actions (SKU_ACTION_KINDS in moat/action_reward_inputs.py).
alter type action_kind add value if not exists 'adjust_price';
