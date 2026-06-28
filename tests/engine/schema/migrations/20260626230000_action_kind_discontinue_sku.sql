-- supabase/migrations/20260626230000_action_kind_discontinue_sku.sql
-- Register discontinue_sku so the engine schema can store + reward SKU
-- discontinue actions (SKU_ACTION_KINDS in moat/action_reward_inputs.py).
alter type action_kind add value if not exists 'discontinue_sku';
