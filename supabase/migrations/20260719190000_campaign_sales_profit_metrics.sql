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
    when lower(coalesce(campaign_name, '')) ~ 'cyber[[:space:]-]*monday|cybermonday'
      then 'Cyber Monday'
    when lower(coalesce(campaign_name, '')) ~ 'black[[:space:]-]*friday|(^|[^a-z0-9])bfcm([^a-z0-9]|$)'
      then 'Black Friday'
    when lower(coalesce(campaign_name, '')) ~ 'holiday|christmas|xmas|boxing[[:space:]-]*day|new[[:space:]-]*year'
      then 'Holiday'
    when lower(coalesce(campaign_name, '')) ~ 'seasonal|spring|summer|autumn|fall|winter'
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

create or replace function public.campaign_performance(p_window_days integer)
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
begin
  if p_window_days not in (7, 30, 90) then
    raise exception 'unsupported campaign window: %', p_window_days
      using errcode = '22023';
  end if;

  return query
  with anchor_day as (
    select current_date as end_day,
           current_date - (p_window_days - 1) as start_day,
           public.current_shop_id() as shop_id
  ),
  spend as (
    select s.campaign_id, sum(s.spend_cents)::bigint as spend_cents
    from public.ad_spend_fact s
    cross join anchor_day a
    where s.shop_id = a.shop_id
      and s.day between a.start_day and a.end_day
    group by s.campaign_id
  ),
  attributed_orders as (
    select a.campaign_id,
           o.id as order_id,
           o.created_at_source,
           sum(a.attributed_revenue_cents)::bigint as attributed_revenue_cents,
           coalesce(o.ship_cost_manual_cents, o.ship_cost_cents)::bigint as carrier_cost_cents
    from public.attribution_fact a
    join public.order_fact o
      on o.id = a.order_id
     and o.shop_id = a.shop_id
    cross join anchor_day d
    where a.shop_id = d.shop_id
      and o.created_at_source::date between d.start_day and d.end_day
      and lower(coalesce(o.financial_status, '')) in
        ('paid', 'partially_paid', 'partially_refunded', 'refunded')
    group by a.campaign_id, o.id, o.created_at_source,
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
    join public.order_line_fact l on l.order_id = ao.order_id
    left join lateral (
      select c.unit_cost_cents, c.source
      from public.cogs_fact c
      where c.sku_id = l.sku_id
        and c.shop_id = public.current_shop_id()
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
     and r.shop_id = public.current_shop_id()
    group by ao.campaign_id, ao.order_id
  ),
  carrier_costs as (
    select campaign_id,
           order_id,
           carrier_cost_cents,
           carrier_cost_cents is not null as carrier_complete
    from attributed_orders
  ),
  fees as (
    select campaign_id,
           order_id,
           round(attributed_revenue_cents * 0.029)::bigint + 30 as fee_cents
    from attributed_orders
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
    select ec.campaign_id,
           array_agg(distinct ec.cost_source order by ec.cost_source)
             filter (where ec.cost_source is not null) as cost_sources
    from effective_cogs ec
    group by ec.campaign_id
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
         case
           when coalesce(o.cost_complete, true) then
             coalesce(o.revenue_cents, 0)
               - coalesce(o.cogs_cents, 0)
               - coalesce(o.carrier_cost_cents, 0)
               - coalesce(o.fee_cents, 0)
               - coalesce(s.spend_cents, 0)
           else null
         end::bigint,
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
  where c.shop_id = a.shop_id
  order by c.name, c.id;
end;
$$;

revoke all on function public.campaign_performance(integer) from public;
revoke all on function public.campaign_performance(integer) from anon;
grant execute on function public.campaign_performance(integer) to authenticated, service_role;
