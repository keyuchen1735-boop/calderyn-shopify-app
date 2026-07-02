-- Failure ledger: make the §7 "platform failure → +1 beta" signal exactly-once
-- per audit row. A terminally failed action leaves its alert open, so the next
-- autopilot tick (or a merchant double-submit) replays the same idempotency
-- key, gets the SAME failed audit back, and would bump beta again — one real
-- failure becoming +1 beta per cron tick, unbounded. Recording the signal
-- through an append-only ledger row keyed (shop_id, audit_id, decision) makes
-- the replay a no-op: the unique index rejects the duplicate and the caller
-- skips the RPC.
--
-- decision gains a 'failure' value (approve/reject stay untouched; their CHECK
-- on reject_reason already permits NULL). audit_id is NULL for legacy rows and
-- for reject rows (which are deduped by the resurfacing filter instead);
-- NULLs are distinct in the unique index, so existing rows are unaffected.

alter table public.action_feedback drop constraint action_feedback_decision_check;
alter table public.action_feedback add constraint action_feedback_decision_check
  check (decision in ('approve', 'reject', 'failure'));

alter table public.action_feedback
  add column if not exists audit_id uuid references public.action_audit(id) on delete set null;

create unique index if not exists action_feedback_once_per_audit
  on public.action_feedback (shop_id, audit_id, decision);
