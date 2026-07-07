-- Per-order confirmation token (platform pivot #2c-2): the unguessable key the buyer's
-- order-confirmation page is fetched by, so the confirmation URL can NEVER be turned into an
-- IDOR. The buyer-facing route looks an order up by (shop_id, confirmation_token) ONLY — never
-- by the raw, enumerable orders.id — so editing the URL to another value (or another buyer's
-- order id) resolves to nothing and 404s, exposing no PII.
--
-- The value is a 256-bit CSPRNG token minted by the app in createCheckout() (checkout.server.ts,
-- node:crypto randomBytes -> base64url). 256 bits is far past the 128-bit floor, so the token is
-- not brute-forceable. Nullable because it is set on the application write path (not a DB default)
-- and no order predates this column in any live environment; the partial unique index guards
-- against a (vanishingly unlikely) token collision while still allowing the NULL backfill window.
--
-- RLS is unchanged: adding a column to public.orders does not drop its existing
-- orders_shop_scope policy (20260629110000_order_spine.sql), and the column inherits it.

alter table public.orders
  add column confirmation_token text;

create unique index orders_confirmation_token_idx
  on public.orders (confirmation_token)
  where confirmation_token is not null;
