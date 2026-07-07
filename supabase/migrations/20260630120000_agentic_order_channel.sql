-- Agentic order channel + per-client commerce authorization (buy-in-chat P2).
--
-- Tag owned `orders` with their origination channel so the dashboard "Agentic channel" panel
-- (P4) and attribution can distinguish a chat sale from a storefront sale. These are ADDITIVE
-- columns on the existing system-of-record table (20260629110000_order_spine.sql) — adding a
-- column to public.orders does NOT drop its existing orders_shop_scope RLS policy, and the new
-- columns inherit it (same as 20260629120001_order_confirmation_token.sql). channel/protocol/
-- client_id are text (free strings, not a Postgres enum — convention: the codebase models
-- bounded sets as text + an app-level vocabulary). channel is NOT NULL with a 'storefront'
-- default so every pre-existing order back-fills as a storefront sale.
alter table public.orders add column if not exists channel   text not null default 'storefront';
alter table public.orders add column if not exists protocol  text;        -- 'acp' | 'mcp' | null
alter table public.orders add column if not exists client_id text;        -- external AI client id (mcp_oauth_clients.client_id)
create index if not exists idx_orders_channel on public.orders (shop_id, channel, created_at desc);

-- Per-client commerce authorization + deterministic spend cap. mcp_oauth_clients
-- (20260608120001_mcp_oauth_clients.sql) already registers external AI clients; these columns
-- add whether a client may transact at all (commerce_scope) and a hard per-order ceiling
-- (spend_cap_cents, integer cents). Spend authority is DETERMINISTIC code, never a model
-- decision (rule 5): assertWithinCommerceCap() reads these and refuses an over-cap order BEFORE
-- any charge. Defaults are off (no scope, 0 cap) so no registered client can transact until a
-- merchant explicitly opts it in. RLS is unchanged (mcp_oauth_clients already has RLS enabled +
-- anon/authenticated revoked); adding columns preserves it.
alter table public.mcp_oauth_clients add column if not exists commerce_scope  boolean not null default false;
alter table public.mcp_oauth_clients add column if not exists spend_cap_cents integer not null default 0; -- 0 = no commerce
