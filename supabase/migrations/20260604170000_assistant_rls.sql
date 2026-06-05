-- Backfill RLS for the assistant chat-history tables.
--
-- The create migration (20260602120000_assistant.sql) shipped without RLS; the
-- live project has since had RLS + a shop-scope policy applied out-of-band, so
-- this brings the supabase/ overlay back in sync and makes the secure state
-- reproducible. Idempotent: safe to re-run and safe whether or not the live
-- project already has the policy.
--
-- Shop isolation uses current_shop_id() like every other per-shop table. anon
-- already cannot set that GUC (EXECUTE on set_current_shop_id was revoked in
-- 20260604150000), so it resolves to NULL for anon and the policy denies; the
-- grants are revoked too for defense-in-depth. The app reaches these tables only
-- via the service-role key (BYPASSRLS), so none of this affects the app.
alter table public.assistant_conversations enable row level security;
alter table public.assistant_messages enable row level security;

drop policy if exists assistant_conversations_shop_scope on public.assistant_conversations;
create policy assistant_conversations_shop_scope on public.assistant_conversations
  for all
  using (shop_id = current_shop_id())
  with check (shop_id = current_shop_id());

drop policy if exists assistant_messages_shop_scope on public.assistant_messages;
create policy assistant_messages_shop_scope on public.assistant_messages
  for all
  using (shop_id = current_shop_id())
  with check (shop_id = current_shop_id());

revoke all on table public.assistant_conversations from anon, authenticated;
revoke all on table public.assistant_messages from anon, authenticated;
