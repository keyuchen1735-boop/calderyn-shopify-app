-- supabase/migrations/20260419000007_create_shopify_sessions.sql
create table public.shopify_sessions (
  id             text primary key,
  shop           text not null,
  state          text not null,
  is_online      boolean not null default false,
  scope          text,
  expires        timestamptz,
  access_token   text,
  user_id        text,
  first_name     text,
  last_name      text,
  email          text,
  account_owner  boolean not null default false,
  locale         text,
  collaborator   boolean,
  email_verified boolean
);

create index shopify_sessions_shop_idx on public.shopify_sessions (shop);
