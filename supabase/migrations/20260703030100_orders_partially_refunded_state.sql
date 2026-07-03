-- Add `partially_refunded` to the owned-order state vocabulary (platform pivot #3b).
-- A partial Stripe refund moves a paid/fulfilled order to `partially_refunded`; a full
-- refund (or a later partial that reaches the captured total) moves it to `refunded`.
-- The legal-transition machine itself lives in app/lib/order/state.ts and is enforced by
-- transitionOrder(); this migration only widens the `orders.state` check-constraint domain
-- so the CAS update can persist the new state.
--
-- Scope: only `orders` gains the state — `cart` / `checkout_session` never reach a refund
-- state (an order is BORN at checkout_pending and only the orders row is transitioned by
-- the refund action), so their check constraints are intentionally left unchanged (surgical
-- change; the shared vocabulary in state.ts documents that orders carries the fuller lifecycle).
--
-- Postgres auto-names the inline check `orders_state_check`; drop-if-exists then re-add so the
-- migration is safe whether or not the auto-name matches on this deployment.
alter table public.orders drop constraint if exists orders_state_check;
alter table public.orders add constraint orders_state_check
  check (state in ('cart','checkout_pending','paid','fulfilled','cancelled','refunded','partially_refunded'));
