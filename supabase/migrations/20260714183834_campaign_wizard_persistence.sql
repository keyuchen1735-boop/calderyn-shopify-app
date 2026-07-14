-- Persist the complete campaign builder state so a saved draft resumes exactly
-- where the merchant left it. Existing name/platform-only drafts remain valid
-- through the empty-object default and are upgraded the next time they are saved.
alter table public.campaign_draft
  add column state jsonb not null default '{}'::jsonb,
  add column updated_at timestamptz not null default now(),
  add constraint campaign_draft_state_object check (jsonb_typeof(state) = 'object');

-- Server-owned generation reservations enforce one initial creative set plus
-- two regenerations for each wizard run/product pair. Rows are inserted before
-- a provider call and removed only when no paid provider was invoked. A paid
-- attempt is retained even if its provider fails so retries cannot bypass the
-- store cost ceiling. The unique attempt key is also the concurrency fence for
-- double-clicks and lost-response retries.
create table public.campaign_wizard_generation_attempt (
  id         uuid primary key default gen_random_uuid(),
  shop_id    uuid not null references public.shops(id) on delete cascade,
  run_id     uuid not null,
  product_id uuid not null references public.product_dim(id) on delete cascade,
  attempt    smallint not null check (attempt between 1 and 3),
  result     jsonb,
  failure_result jsonb,
  provider_started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (shop_id, run_id, product_id, attempt)
);

create index campaign_wizard_generation_attempt_shop_run_idx
  on public.campaign_wizard_generation_attempt (shop_id, run_id, product_id);
create index campaign_wizard_generation_attempt_shop_created_idx
  on public.campaign_wizard_generation_attempt (shop_id, created_at);

alter table public.campaign_wizard_generation_attempt enable row level security;
create policy campaign_wizard_generation_attempt_shop_scope
  on public.campaign_wizard_generation_attempt
  for all
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());

revoke all on table public.campaign_wizard_generation_attempt from anon, authenticated;
grant select, insert, delete on table public.campaign_wizard_generation_attempt to service_role;
grant update on table public.campaign_wizard_generation_attempt to service_role;

-- One transaction owns the per-shop advisory lock while it checks the rolling
-- cost ceiling and inserts the exact attempt. Completed duplicates return their
-- stored response; in-flight duplicates never call a provider twice.
create or replace function public.reserve_campaign_wizard_generation_attempt(
  p_shop_id uuid,
  p_run_id uuid,
  p_product_id uuid,
  p_attempt smallint
)
returns table (
  reservation_id uuid,
  outcome text,
  regenerations_left integer,
  saved_result jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_result jsonb;
  v_failure_result jsonb;
  v_provider_started_at timestamptz;
  v_created_at timestamptz;
  v_daily integer;
begin
  if p_attempt < 1 or p_attempt > 3 then
    raise exception 'attempt must be between 1 and 3';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_shop_id::text, 0));

  select a.id, a.result, a.failure_result, a.provider_started_at, a.created_at
    into v_id, v_result, v_failure_result, v_provider_started_at, v_created_at
    from public.campaign_wizard_generation_attempt a
   where a.shop_id = p_shop_id
     and a.run_id = p_run_id
     and a.product_id = p_product_id
     and a.attempt = p_attempt;

  -- A worker can disappear before a provider starts; that cost-free reservation
  -- can be reclaimed safely. Once a provider is marked started, never delete
  -- the ledger row: after the worker timeout, replay its pre-recorded fallback
  -- so the merchant can continue without invoking the provider a second time.
  if found and v_result is not null then
    reservation_id := v_id;
    outcome := 'replay';
    regenerations_left := greatest(0, 3 - p_attempt);
    saved_result := v_result;
    return next;
    return;
  elsif found
    and v_provider_started_at is not null
    and v_provider_started_at < now() - interval '10 minutes'
  then
    reservation_id := v_id;
    outcome := 'replay';
    regenerations_left := greatest(0, 3 - p_attempt);
    saved_result := v_failure_result;
    return next;
    return;
  elsif found
    and v_provider_started_at is null
    and v_created_at < now() - interval '10 minutes'
  then
    delete from public.campaign_wizard_generation_attempt
     where id = v_id;
  elsif found then
    reservation_id := v_id;
    outcome := 'in_progress';
    regenerations_left := greatest(0, 3 - p_attempt);
    saved_result := null;
    return next;
    return;
  end if;

  select count(*)::integer
    into v_daily
    from public.campaign_wizard_generation_attempt a
   where a.shop_id = p_shop_id
     and a.created_at >= now() - interval '24 hours';

  if v_daily >= 30 then
    reservation_id := null;
    outcome := 'daily_limit';
    regenerations_left := 0;
    saved_result := null;
    return next;
    return;
  end if;

  insert into public.campaign_wizard_generation_attempt
    (shop_id, run_id, product_id, attempt)
  values
    (p_shop_id, p_run_id, p_product_id, p_attempt)
  returning id into v_id;

  reservation_id := v_id;
  outcome := 'reserved';
  regenerations_left := greatest(0, 3 - p_attempt);
  saved_result := null;
  return next;
end;
$$;

revoke all on function public.reserve_campaign_wizard_generation_attempt(uuid, uuid, uuid, smallint)
  from public, anon, authenticated;
grant execute on function public.reserve_campaign_wizard_generation_attempt(uuid, uuid, uuid, smallint)
  to service_role;
