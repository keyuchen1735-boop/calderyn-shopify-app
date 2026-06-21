-- Merchant feedback on proposed actions: approve or reject with optional reason.
-- Drives the rejection learning signal (calibration_record_rejection fn) and
-- informs the rule engine (calibration_rule table). RLS scopes every row to
-- the owning shop.

create table public.action_feedback (
  id             uuid         not null default gen_random_uuid() primary key,
  shop_id        uuid         not null references public.shops(id) on delete cascade,
  alert_id       uuid,
  detector_id    text         not null,
  action_kind    public.action_kind not null,
  decision       text         not null check (decision in ('approve', 'reject')),
  reject_reason  text         check (reject_reason in ('too_aggressive', 'wrong_timing', 'not_enough_data', 'i_handle_this', 'other')),
  note           text,
  applied_rule   jsonb,
  created_at     timestamptz  not null default now()
);

create index action_feedback_shop_alert_idx on public.action_feedback (shop_id, alert_id);

alter table public.action_feedback enable row level security;
alter table public.action_feedback force row level security;

create policy action_feedback_scope on public.action_feedback
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
