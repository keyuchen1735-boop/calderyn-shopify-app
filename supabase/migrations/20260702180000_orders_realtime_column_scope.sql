-- Tighten the dashboard realtime exposure of orders (review finding on
-- 20260702160000_storefront_event.sql): the live "order ping" only needs to
-- know that a row changed. Replace the table-wide SELECT grant with a
-- column-scoped one so WALRUS never streams confirmation_token (an
-- IDOR-defense capability, see storefront.checkout.confirmation.$token.tsx)
-- or the attribution blob to the authenticated dashboard JWT. RLS policy
-- evaluation is unaffected by column grants; delivery still requires the
-- dashboard_read_orders shop_id policy to match.
revoke select on table public.orders from authenticated;
grant select (id, shop_id, state, financial_status, total_cents, currency, created_at)
  on public.orders to authenticated;
