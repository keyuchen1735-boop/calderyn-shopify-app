-- Peer Benchmarks — merchant-facing "your store vs your niche".
-- New prod table (codified, unlike the legacy moat schema), a public read
-- view over it, and the four KPI views + niche view that are the SHARED
-- definition for the Python writer and the TS reader.

create schema if not exists moat;

-- 1. The k-anonymized aggregate. n is always >= 5 (k-floor enforced in ETL);
--    the check fails loudly if a sub-floor row is ever inserted.
create table if not exists moat.peer_metric_baselines (
  metric_key  text          not null,
  segment     text          not null,
  p25         numeric(18,6) not null,
  p50         numeric(18,6) not null,
  p75         numeric(18,6) not null,
  n           integer       not null,
  computed_at timestamptz   not null default now(),
  primary key (metric_key, segment),
  check (n >= 5)
);

-- Engine role writes + deletes (delete-stale). NB: legacy moat.peer_baselines
-- was granted only select/insert/update even though consent_purge deletes from
-- it — we grant delete here to match actual usage. Guarded for prod, where the
-- custom roles may not exist.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_engine') then
    grant select, insert, update, delete on moat.peer_metric_baselines to app_engine;
  end if;
end $$;

-- 2. Public read surface (security DEFINER by default → reads moat under the
--    owner, so the public/service-role read path needs no moat grant). Safe:
--    the rows are k-anonymized aggregates, not per-shop data.
create or replace view public.v_peer_metric_baselines as
  select metric_key, segment, p25, p50, p75, n, computed_at
    from moat.peer_metric_baselines;

-- 3. KPI views — ONE shared definition per KPI, current_date-windowed.
--    security_invoker matches the v_order_ship_features convention; both
--    callers (service_role read path, engine ETL role) read cross-shop fine.
create or replace view public.v_peer_kpi_aov
  with (security_invoker = true) as
  select shop_id, (avg(total_cents) / 100.0)::numeric as value
    from public.order_fact
   where created_at_source >= (current_date - interval '30 days')
   group by shop_id;

create or replace view public.v_peer_kpi_return_rate
  with (security_invoker = true) as
  select shop_id,
         (sum(return_cents)::numeric / nullif(sum(revenue_cents), 0)) as value
    from public.sku_pnl
   where day >= (current_date - interval '30 days')
   group by shop_id;

create or replace view public.v_peer_kpi_gross_margin_pct
  with (security_invoker = true) as
  select shop_id,
         (sum(revenue_cents - cogs_cents)::numeric
            / nullif(sum(revenue_cents), 0)) as value
    from public.sku_pnl
   where day >= (current_date - interval '30 days')
   group by shop_id;

-- ponytail: orders with no resolved ship cost contribute null (sum skips them),
-- mildly undercounting; upgrade to weight by known-cost orders if it matters.
create or replace view public.v_peer_kpi_ship_cost_pct
  with (security_invoker = true) as
  select shop_id,
         (sum(coalesce(ship_cost_manual_cents, ship_cost_cents))::numeric
            / nullif(sum(total_cents), 0)) as value
    from public.order_fact
   where created_at_source >= (current_date - interval '30 days')
   group by shop_id;

-- 4. Niche view — dominant sku_dim.category by trailing-90d GMV. Mirrors
--    category_niche_for_shop (Python) for read-time (current_date). Tie-break
--    gmv desc, category asc — deterministic, matches the resolver.
create or replace view public.v_peer_shop_niche
  with (security_invoker = true) as
  with cat_gmv as (
    select p.shop_id, sd.category, sum(p.revenue_cents) as gmv_cents
      from public.sku_pnl p
      join public.sku_dim sd on sd.id = p.sku_id
     where sd.category is not null
       and p.day >= (current_date - interval '90 days')
       and p.day <= current_date  -- exact mirror of category_niche_for_shop's window
     group by p.shop_id, sd.category
  ),
  ranked as (
    select shop_id, category,
           row_number() over (
             partition by shop_id order by gmv_cents desc, category asc
           ) as rn
      from cat_gmv
  )
  select shop_id, 'cat:' || category as segment
    from ranked where rn = 1;
