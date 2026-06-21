-- Derived rules generated from merchant rejection patterns. The rule engine
-- reads these to suppress or constrain future action proposals for a given
-- (detector, action) pair. RLS scopes every row to the owning shop.

create table public.calibration_rule (
  id             uuid         not null default gen_random_uuid() primary key,
  shop_id        uuid         not null references public.shops(id) on delete cascade,
  detector_id    text         not null,
  action_kind    public.action_kind not null,
  rule_kind      text         not null check (rule_kind in ('muted_pair', 'pair_dollar_cap', 'pair_min_spend', 'pair_blackout_hours', 'pair_probation_until', 'pair_mu_override')),
  rule_value     jsonb        not null default '{}',
  active         boolean      not null default true,
  source         text,
  superseded_by  uuid,
  created_at     timestamptz  not null default now()
);

create index calibration_rule_shop_active_idx on public.calibration_rule (shop_id, active);

alter table public.calibration_rule enable row level security;
alter table public.calibration_rule force row level security;

create policy calibration_rule_scope on public.calibration_rule
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
