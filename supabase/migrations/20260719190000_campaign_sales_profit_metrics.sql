alter table public.ad_campaign_dim
  add column if not exists campaign_kind text not null default 'regular'
    check (campaign_kind in ('sales', 'regular')),
  add column if not exists sale_type text
    check (sale_type is null or char_length(btrim(sale_type)) between 1 and 80),
  add column if not exists classification_source text not null default 'detected'
    check (classification_source in ('detected', 'merchant'));

create or replace function public.detect_campaign_sale_type(campaign_name text)
returns text
language sql
immutable
parallel safe
as $$
  select case
    when lower(coalesce(campaign_name, '')) ~ '(^|[^a-z0-9])cyber[[:space:]]+monday([^a-z0-9]|$)'
      then 'Cyber Monday'
    when lower(coalesce(campaign_name, '')) ~ '(^|[^a-z0-9])(black[[:space:]]+friday|bfcm)([^a-z0-9]|$)'
      then 'Black Friday'
    when lower(coalesce(campaign_name, '')) ~ '(^|[^a-z0-9])(holiday|christmas|boxing[[:space:]]+day)([^a-z0-9]|$)'
      then 'Holiday'
    when lower(coalesce(campaign_name, '')) ~ '(^|[^a-z0-9])(spring|summer|fall|autumn|winter)[[:space:]-]+sale([^a-z0-9]|$)|(^|[^a-z0-9])back[[:space:]-]+to[[:space:]-]+school([^a-z0-9]|$)'
      then 'Seasonal'
    when lower(coalesce(campaign_name, '')) ~ '(^|[^a-z0-9])(sale|promo|promotion|discount|clearance)([^a-z0-9]|$)'
      then 'General Sale'
    else null
  end
$$;

create or replace function public.classify_campaign_on_insert()
returns trigger
language plpgsql
as $$
begin
  if new.classification_source = 'merchant' then
    return new;
  end if;

  new.sale_type := public.detect_campaign_sale_type(new.name);
  new.campaign_kind := case when new.sale_type is null then 'regular' else 'sales' end;
  new.classification_source := 'detected';
  return new;
end;
$$;

drop trigger if exists ad_campaign_classify_insert on public.ad_campaign_dim;
create trigger ad_campaign_classify_insert
before insert on public.ad_campaign_dim
for each row execute function public.classify_campaign_on_insert();

update public.ad_campaign_dim
set sale_type = public.detect_campaign_sale_type(name),
    campaign_kind = case
      when public.detect_campaign_sale_type(name) is null then 'regular'
      else 'sales'
    end
where classification_source = 'detected';

create or replace function public.campaign_performance(
  p_window_days integer,
  p_shop_id uuid default null
)
returns table (
  id uuid,
  name text,
  platform public.ad_platform,
  status text,
  daily_budget_cents integer,
  campaign_kind text,
  sale_type text,
  classification_source text,
  orders bigint,
  revenue_cents bigint,
  spend_cents bigint,
  profit_cents bigint,
  true_roas numeric,
  cost_complete boolean,
  cost_sources text[]
)
language plpgsql
stable
security invoker
set search_path = public, pg_catalog
as $$
declare
  v_context_shop_id uuid := public.current_shop_id();
  v_shop_id uuid;
begin
  if p_window_days is null or p_window_days not in (7, 30, 90) then
    raise exception 'unsupported campaign window: %', p_window_days
      using errcode = '22023';
  end if;

  if v_context_shop_id is not null then
    if p_shop_id is not null and p_shop_id <> v_context_shop_id then
      raise exception 'campaign shop context mismatch'
        using errcode = '42501';
    end if;
    v_shop_id := v_context_shop_id;
  elsif current_user in ('service_role', 'postgres') and p_shop_id is not null then
    v_shop_id := p_shop_id;
  else
    raise exception 'campaign shop context required'
      using errcode = '42501';
  end if;

  return query
  with reporting_config as (
    select coalesce(
      (select g.timezone from public.guardrail_config g where g.shop_id = v_shop_id),
      'America/New_York'
    ) as timezone
  ),
  anchor_day as (
    select coalesce(max(s.day), current_date) as end_day,
           coalesce(max(s.day), current_date) - (p_window_days - 1) as start_day
    from public.ad_spend_fact s
    where s.shop_id = v_shop_id
  ),
  spend as (
    select s.campaign_id, sum(s.spend_cents)::bigint as spend_cents
    from public.ad_spend_fact s
    cross join anchor_day a
    where s.shop_id = v_shop_id
      and s.day between a.start_day and a.end_day
    group by s.campaign_id
  ),
  attributed_orders as (
    select a.campaign_id,
           o.id as order_id,
           o.order_number,
           o.total_cents,
           o.created_at_source,
           sum(a.attributed_revenue_cents)::bigint as attributed_revenue_cents,
           coalesce(o.ship_cost_manual_cents, o.ship_cost_cents)::bigint as carrier_cost_cents
    from public.attribution_fact a
    join public.order_fact o
      on o.id = a.order_id
     and o.shop_id = v_shop_id
    cross join anchor_day d
    cross join reporting_config rc
    where a.shop_id = v_shop_id
      and (o.created_at_source at time zone rc.timezone)::date between d.start_day and d.end_day
      and lower(coalesce(o.financial_status, '')) in
        ('paid', 'partially_paid', 'partially_refunded', 'refunded')
    group by a.campaign_id, o.id, o.order_number, o.total_cents, o.created_at_source,
             o.ship_cost_manual_cents, o.ship_cost_cents
  ),
  effective_cogs as (
    select ao.campaign_id,
           ao.order_id,
           l.id as line_id,
           l.quantity,
           coalesce(l.unit_cost_cents_snapshot, historical.unit_cost_cents) as unit_cost_cents,
           case
             when l.unit_cost_cents_snapshot is not null then 'snapshot'
             when historical.source = 'quickbooks' then 'quickbooks'
             when historical.source is not null then 'catalog'
             else null
           end as cost_source
    from attributed_orders ao
    join public.order_line_fact l
      on l.order_id = ao.order_id
     and l.shop_id = v_shop_id
    left join lateral (
      select c.unit_cost_cents, c.source
      from public.cogs_fact c
      where c.sku_id = l.sku_id
        and c.shop_id = v_shop_id
        and c.effective_from <= ao.created_at_source
        and (c.effective_to is null or c.effective_to > ao.created_at_source)
      order by (c.source = 'quickbooks') desc, c.effective_from desc
      limit 1
    ) historical on l.unit_cost_cents_snapshot is null
  ),
  cogs as (
    select ao.campaign_id,
           ao.order_id,
           coalesce(sum(ec.quantity * ec.unit_cost_cents), 0)::bigint as cogs_cents,
           count(ec.line_id) > 0
             and bool_and(ec.unit_cost_cents is not null) as cogs_complete
    from attributed_orders ao
    left join effective_cogs ec on ec.order_id = ao.order_id
    group by ao.campaign_id, ao.order_id
  ),
  refunds as (
    select ao.campaign_id,
           ao.order_id,
           coalesce(sum(r.subtotal_cents), 0)::bigint as refund_cents
    from attributed_orders ao
    left join public.refund_fact r
      on r.order_id = ao.order_id
     and r.shop_id = v_shop_id
    group by ao.campaign_id, ao.order_id
  ),
  carrier_costs as (
    select campaign_id,
           order_id,
           carrier_cost_cents,
           carrier_cost_cents is not null as carrier_complete
    from attributed_orders
  ),
  captures as (
    select ao.campaign_id,
           ao.order_id,
           count(tl.id)::bigint as capture_count,
           coalesce(sum(tl.amount_cents), ao.total_cents)::bigint as captured_revenue_cents
    from attributed_orders ao
    left join public.transaction_ledger tl
      on tl.shop_id = v_shop_id
     and tl.order_ref = ao.order_number
     and tl.kind = 'capture'
    group by ao.campaign_id, ao.order_id, ao.total_cents
  ),
  fees as (
    select campaign_id,
           order_id,
           round(captured_revenue_cents * 0.029)::bigint
             + greatest(capture_count, 1) * 30 as fee_cents
    from captures
  ),
  order_metrics as (
    select ao.campaign_id,
           ao.order_id,
           greatest(ao.attributed_revenue_cents - r.refund_cents, 0)::bigint as revenue_cents,
           c.cogs_cents,
           cc.carrier_cost_cents,
           f.fee_cents,
           c.cogs_complete and cc.carrier_complete as cost_complete
    from attributed_orders ao
    join cogs c using (campaign_id, order_id)
    join refunds r using (campaign_id, order_id)
    join carrier_costs cc using (campaign_id, order_id)
    join fees f using (campaign_id, order_id)
  ),
  campaign_orders as (
    select om.campaign_id,
           count(distinct om.order_id)::bigint as orders,
           sum(om.revenue_cents)::bigint as revenue_cents,
           sum(om.cogs_cents)::bigint as cogs_cents,
           sum(om.carrier_cost_cents)::bigint as carrier_cost_cents,
           sum(om.fee_cents)::bigint as fee_cents,
           bool_and(om.cost_complete) as cost_complete
    from order_metrics om
    group by om.campaign_id
  ),
  campaign_cost_sources as (
    select sources.campaign_id,
           array_agg(distinct sources.cost_source order by sources.cost_source) as cost_sources
    from (
      select ec.campaign_id, ec.cost_source
      from effective_cogs ec
      where ec.cost_source is not null
      union all
      select c.campaign_id, 'missing:cogs'
      from cogs c
      where not c.cogs_complete
      union all
      select cc.campaign_id, 'missing:carrier'
      from carrier_costs cc
      where not cc.carrier_complete
    ) sources
    group by sources.campaign_id
  )
  select c.id,
         c.name,
         c.platform,
         c.status,
         c.daily_budget_cents,
         c.campaign_kind,
         c.sale_type,
         c.classification_source,
         coalesce(o.orders, 0)::bigint,
         coalesce(o.revenue_cents, 0)::bigint,
         coalesce(s.spend_cents, 0)::bigint,
         (coalesce(o.revenue_cents, 0)
            - coalesce(o.cogs_cents, 0)
            - coalesce(o.carrier_cost_cents, 0)
            - coalesce(o.fee_cents, 0)
            - coalesce(s.spend_cents, 0))::bigint,
         round(
           coalesce(o.revenue_cents, 0)::numeric
             / nullif(coalesce(s.spend_cents, 0), 0),
           4
         ),
         coalesce(o.cost_complete, true),
         coalesce(cs.cost_sources, array[]::text[])
  from public.ad_campaign_dim c
  cross join anchor_day a
  left join spend s on s.campaign_id = c.id
  left join campaign_orders o on o.campaign_id = c.id
  left join campaign_cost_sources cs on cs.campaign_id = c.id
  where c.shop_id = v_shop_id
  order by c.name, c.id;
end;
$$;

revoke all on function public.campaign_performance(integer, uuid) from public;
revoke all on function public.campaign_performance(integer, uuid) from anon;
grant execute on function public.campaign_performance(integer, uuid) to authenticated, service_role;

create index if not exists campaign_perf_ad_spend_shop_day_idx
  on public.ad_spend_fact (shop_id, day);
create index if not exists campaign_perf_order_line_shop_order_idx
  on public.order_line_fact (shop_id, order_id);
create index if not exists campaign_perf_refund_shop_order_idx
  on public.refund_fact (shop_id, order_id);

do $$
begin
  if to_regclass('public.transaction_ledger') is not null then
    execute 'create index if not exists campaign_perf_ledger_shop_order_idx
      on public.transaction_ledger (shop_id, order_ref)';
  end if;
end
$$;
