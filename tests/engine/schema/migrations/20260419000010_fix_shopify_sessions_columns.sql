-- supabase/migrations/20260419000010_fix_shopify_sessions_columns.sql
--
-- Bug #5 (discovered during Plan 01 Task 21 smoke test):
-- @shopify/shopify-app-session-storage-postgresql writes quoted camelCase
-- column names ("isOnline", "accessToken", "userId", "firstName", etc.)
-- because the library calls session.toPropertyArray() and uses the returned
-- keys verbatim as column identifiers. Postgres preserves case for quoted
-- identifiers, so "isOnline" != is_online.
--
-- Migration 007 created the table with snake_case column names, so every
-- INSERT from the library failed with:
--   column "isOnline" of relation "shopify_sessions" does not exist
--
-- No sessions have been persisted yet (the error happens on the very first
-- INSERT during OAuth callback), so dropping and recreating is safe.
--
-- Keeping this table RLS-disabled (matching the original design in 007):
-- session storage is library-internal, scoped by the app-layer lookup on
-- shop domain, not by our tenant RLS.

drop index if exists public.shopify_sessions_shop_idx;
drop table if exists public.shopify_sessions;

create table public.shopify_sessions (
  id               varchar(255) primary key,
  shop             varchar(255) not null,
  state            varchar(255) not null,
  "isOnline"       boolean not null default false,
  scope            varchar(255),
  expires          timestamptz,
  "accessToken"    varchar(255),
  "userId"         bigint,
  "firstName"      varchar(255),
  "lastName"       varchar(255),
  email            varchar(255),
  "accountOwner"   boolean not null default false,
  locale           varchar(255),
  collaborator     boolean,
  "emailVerified"  boolean
);

create index shopify_sessions_shop_idx on public.shopify_sessions (shop);
