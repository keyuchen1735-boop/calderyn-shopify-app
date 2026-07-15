-- Turn the existing per-image quota rows into a durable provider-cost ledger.
-- Existing rows represent completed images because the old implementation
-- deleted reservations whenever generation failed.
alter table public.image_gen_event
  add column generation_id uuid not null default gen_random_uuid(),
  add column provider text not null default 'gemini',
  add column model text not null default 'gemini-3.1-flash-lite-image',
  add column purpose text not null default 'legacy',
  add column status text not null default 'succeeded',
  add column provider_request_id text,
  add column provider_started_at timestamptz,
  add column completed_at timestamptz,
  add column input_tokens integer,
  add column output_tokens integer,
  add column thought_tokens integer,
  add column estimated_cost_usd_micros bigint not null default 33600,
  add column error_code text,
  add constraint image_gen_event_status_check
    check (status in ('reserved', 'succeeded', 'failed')),
  add constraint image_gen_event_token_counts_check
    check (
      (input_tokens is null or input_tokens >= 0)
      and (output_tokens is null or output_tokens >= 0)
      and (thought_tokens is null or thought_tokens >= 0)
    ),
  add constraint image_gen_event_cost_check
    check (estimated_cost_usd_micros >= 0);

update public.image_gen_event
   set provider_started_at = created_at,
       completed_at = created_at,
       output_tokens = 1120
 where status = 'succeeded';

create index image_gen_event_generation_idx
  on public.image_gen_event (generation_id);
create index image_gen_event_shop_cost_idx
  on public.image_gen_event (shop_id, created_at desc)
  include (provider, model, purpose, status, estimated_cost_usd_micros);

-- Reserve an entire image batch in one transaction. The global advisory lock
-- serializes all shops while the shop lock keeps the tenant boundary explicit.
-- Both limits are passed by the trusted server so they remain environment
-- tunable without allowing browser roles to invoke this function.
create or replace function public.reserve_image_generation_slots(
  p_shop_id uuid,
  p_count integer,
  p_per_shop_daily integer,
  p_global_daily integer,
  p_day date,
  p_generation_id uuid,
  p_provider text,
  p_model text,
  p_purpose text
)
returns table (
  event_ids uuid[],
  blocked_scope text,
  limit_value integer,
  remaining integer
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_shop_count integer;
  v_global_count integer;
  v_ids uuid[];
begin
  if p_count < 1 or p_count > 12 then
    raise exception 'image generation count must be between 1 and 12';
  end if;
  if p_per_shop_daily < 1 or p_global_daily < 1 then
    raise exception 'image generation limits must be positive';
  end if;
  if p_per_shop_daily > p_global_daily then
    raise exception 'per-shop image limit cannot exceed global limit';
  end if;
  if nullif(btrim(p_provider), '') is null
    or nullif(btrim(p_model), '') is null
    or nullif(btrim(p_purpose), '') is null
  then
    raise exception 'image generation metadata is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('image-generation-global', 0));
  perform pg_advisory_xact_lock(hashtextextended(p_shop_id::text, 0));

  select count(*)::integer
    into v_shop_count
    from public.image_gen_event e
   where e.shop_id = p_shop_id
     and e.day = p_day;

  select count(*)::integer
    into v_global_count
    from public.image_gen_event e
   where e.day = p_day;

  if v_shop_count + p_count > p_per_shop_daily then
    event_ids := '{}'::uuid[];
    blocked_scope := 'shop';
    limit_value := p_per_shop_daily;
    remaining := greatest(0, p_per_shop_daily - v_shop_count);
    return next;
    return;
  end if;

  if v_global_count + p_count > p_global_daily then
    event_ids := '{}'::uuid[];
    blocked_scope := 'global';
    limit_value := p_global_daily;
    remaining := greatest(0, p_global_daily - v_global_count);
    return next;
    return;
  end if;

  with inserted as (
    insert into public.image_gen_event (
      shop_id,
      day,
      generation_id,
      provider,
      model,
      purpose,
      status,
      estimated_cost_usd_micros
    )
    select
      p_shop_id,
      p_day,
      p_generation_id,
      btrim(p_provider),
      btrim(p_model),
      btrim(p_purpose),
      'reserved',
      0
      from generate_series(1, p_count)
    returning id
  )
  select coalesce(array_agg(id), '{}'::uuid[])
    into v_ids
    from inserted;

  event_ids := v_ids;
  blocked_scope := null;
  limit_value := null;
  remaining := greatest(0, p_per_shop_daily - v_shop_count - p_count);
  return next;
end;
$$;

revoke all on function public.reserve_image_generation_slots(
  uuid, integer, integer, integer, date, uuid, text, text, text
) from public, anon, authenticated;
grant execute on function public.reserve_image_generation_slots(
  uuid, integer, integer, integer, date, uuid, text, text, text
) to service_role;
