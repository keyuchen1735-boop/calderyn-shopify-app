-- v_order_ship_features evaluates a correlated subquery per order:
--   (select count(*) from fulfillment_fact f where f.order_id = o.id)
-- fulfillment_fact carried indexes on (id), (shop_id, external_id) and
-- (location_id, shipped_at) but NONE on order_id, so that subplan fell back to a
-- SEQUENTIAL SCAN of the whole table for every order the view emitted.
--
-- Cost of the shop-filtered view before this index: 1,945,428. After: 6,977
-- (the per-order subplan alone drops 516.40 -> 1.40). In production the view was
-- the top query on the instance by a wide margin -- ~13 CPU-hours across ~18k
-- PostgREST calls at a 1.6-3.5s mean -- which saturated the database, exhausted
-- the connection pooler ("unable to check out connection from the pool after
-- 15000ms in Transaction mode"), and cascaded into `upstream request timeout`
-- on unrelated reads: tenant storefronts and dashboard APIs both went down.
--
-- Applied to prod 2026-07-22 to stop the incident; checked in here so the
-- repo's migrations match the live database.
create index if not exists fulfillment_fact_order_id_idx
  on public.fulfillment_fact (order_id);

-- INCIDENT MITIGATION, NOT A PERMANENT SETTING.
-- With the instance CPU-throttled, PostgREST's schema-cache introspection took
-- ~10.3s and blew the authenticator role's 8s statement_timeout, so the cache
-- never loaded and EVERY REST call returned 503 PGRST002 — a total API outage
-- on top of the slowness. Raised to 30s so the cache can load while the
-- instance is degraded.
--
-- REVERT TO 8s once the database is healthy (a loose timeout lets a future
-- runaway query hold a connection ~4x longer, which is exactly the failure mode
-- that started this):
--   alter role authenticator set statement_timeout = '8s';
alter role authenticator set statement_timeout = '30s';
