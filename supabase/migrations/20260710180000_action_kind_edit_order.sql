-- Register the edit_order action kind (orders phase 3, Task 3) and give order_line_edit its own
-- idempotency lane. executeReduceLineAction (app/lib/order/edit.server.ts) writes ONE
-- action_audit row per reduction with action_kind = 'edit_order' — without the enum value the
-- insert would be rejected AFTER the order_line_edit row + refund already committed (the same
-- class of bug that bit issue_refund / fulfill_order / cancel_order before their migrations), so
-- register it first. ALTER TYPE ... ADD VALUE is idempotent-guarded with IF NOT EXISTS.
alter type public.action_kind add value if not exists 'edit_order';

-- Crash-window guard (see edit.server.ts module header): the outer action_audit/action_idempotency
-- pair only proves a COMPLETED execution happened for a key. If a prior attempt inserted the
-- order_line_edit row but crashed before its action_audit tail landed, priorExecutionForKey sees
-- nothing and a retry would otherwise insert a SECOND edit row (double-reducing the line). Keying
-- order_line_edit on the caller's idempotency_key lets a retry find and reuse the already-committed
-- row instead.
alter table public.order_line_edit add column if not exists idempotency_key text;
create unique index if not exists order_line_edit_idem on public.order_line_edit (shop_id, idempotency_key)
  where idempotency_key is not null;
