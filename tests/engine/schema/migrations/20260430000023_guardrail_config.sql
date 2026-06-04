-- supabase/migrations/20260430000023_guardrail_config.sql
-- Plan 04 Task 2: guardrail_config table seeded on shop insert via trigger.

create table guardrail_config (
  shop_id                       uuid primary key references shops(id) on delete cascade,
  daily_action_budget           int not null default 10,
  dollar_impact_cap_without_2fa numeric(12, 2) not null default 10000,
  cooldown_minutes_per_campaign int not null default 30,
  business_hours_only           boolean not null default false,
  business_hours_start_utc      int not null default 14, -- 09:00 ET
  business_hours_end_utc        int not null default 0,  -- 19:00 ET
  timezone                      text not null default 'America/New_York',
  updated_at                    timestamptz not null default now()
);

alter table guardrail_config enable row level security;
create policy guardrail_config_shop_scope on guardrail_config
  using (shop_id = current_shop_id())
  with check (shop_id = current_shop_id());

create or replace function seed_guardrail_config()
returns trigger
language plpgsql
as $$
begin
  insert into guardrail_config (shop_id) values (new.id) on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists shops_seed_guardrails on shops;
create trigger shops_seed_guardrails
  after insert on shops
  for each row execute function seed_guardrail_config();
