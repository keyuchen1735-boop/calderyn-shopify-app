-- Stores the founder's LinkedIn OAuth connection for auto-posting the weekly
-- carousel (w_member_social). Tokens are sensitive — service-role only, RLS on
-- with no policies (service role bypasses; anon/authenticated get no access).
-- One row per member; re-connecting upserts on member_urn.

create table if not exists public.linkedin_connection (
  id                 uuid primary key default gen_random_uuid(),
  member_urn         text        not null unique,
  access_token       text        not null,
  refresh_token      text,
  expires_at         timestamptz not null,
  refresh_expires_at timestamptz,
  scope              text,
  connected_at       timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on table public.linkedin_connection is
  'Founder LinkedIn OAuth tokens for social-digest auto-post. Service-role only.';

alter table public.linkedin_connection enable row level security;