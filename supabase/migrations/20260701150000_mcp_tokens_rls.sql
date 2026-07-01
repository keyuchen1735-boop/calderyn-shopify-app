-- Backfill RLS for mcp_tokens (per-shop bearer tokens for the calderyn-mcp server).
--
-- mcp_tokens carries shop_id but shipped without RLS. Add the standard per-shop
-- policy so any non-service-role reader is confined to its own shop's rows. This
-- is defense-in-depth behind the query-level shop scoping in the Agentic Channel
-- loader (dashboard.api.agentic._index): the app reaches this table only via the
-- service-role key (BYPASSRLS), so this does not affect the app. Idempotent: safe
-- to re-run and safe whether or not the live project already has the policy.
--
-- Shop isolation uses current_shop_id() like every other per-shop table. anon
-- cannot set that GUC (EXECUTE on set_current_shop_id was revoked in
-- 20260604150000), so it resolves to NULL for anon and the policy denies; the
-- grants are revoked too for defense-in-depth.
alter table public.mcp_tokens enable row level security;

drop policy if exists mcp_tokens_shop_scope on public.mcp_tokens;
create policy mcp_tokens_shop_scope on public.mcp_tokens
  for all
  using (shop_id = current_shop_id())
  with check (shop_id = current_shop_id());

revoke all on table public.mcp_tokens from anon, authenticated;
