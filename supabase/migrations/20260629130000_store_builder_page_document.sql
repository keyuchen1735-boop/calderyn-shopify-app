-- supabase/migrations/20260629130000_store_builder_page_document.sql
-- Visual store builder (#16/#8) spine: persisted block documents. One row per (shop_id,
-- page_key). draft_json is the editable/in-progress doc; published_json is what the public
-- storefront renders. RLS modeled on buyer_identity (20260629100000): own shop_id + a
-- `shop_id = current_shop_id()` policy; anon/authenticated grants revoked. The app reaches
-- this table only via the service-role key (BYPASSRLS), threading shop_id on every query.
create table public.page_document (
  shop_id        uuid not null references public.shops(id) on delete cascade,
  page_key       text not null,
  kind           text not null check (kind in ('singleton','template')),
  draft_json     jsonb,
  published_json jsonb,
  updated_at     timestamptz not null default now(),
  primary key (shop_id, page_key)
);
alter table public.page_document enable row level security;
create policy page_document_shop_scope on public.page_document
  for all
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
revoke all on table public.page_document from anon, authenticated;
