-- The reallocate_budget composite action (move N cents/day of budget from one
-- campaign to another, possibly cross-platform) needs its action_kind value.
-- NOTE: distinct from the existing reallocate_inventory (inventory-side).

alter type public.action_kind add value if not exists 'reallocate_budget';
