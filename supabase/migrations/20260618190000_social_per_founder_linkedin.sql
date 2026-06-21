-- Per-founder LinkedIn posting. Each founder connects their OWN LinkedIn, so a
-- connection is owned by a founder email; and each (drop, founder) gets at most
-- one LinkedIn post via a unique-constrained claim row (kills double-posting).

-- 1. Tie each LinkedIn connection to the founder who owns it.
alter table public.linkedin_connection add column if not exists owner_email text;
update public.linkedin_connection
  set owner_email = 'keyuchen@calderyncompany.com'
  where owner_email is null;
create unique index if not exists linkedin_connection_owner_email_key
  on public.linkedin_connection (owner_email);

-- 2. Per-(drop, founder, platform) post claim + result. The unique constraint is
-- the atomic single-post guard: insert-on-conflict-do-nothing = claim.
create table if not exists public.social_link_post (
  id          uuid primary key default gen_random_uuid(),
  digest_id   uuid        not null,
  owner_email text        not null,
  platform    text        not null default 'linkedin',
  status      text        not null check (status in ('posting', 'posted', 'failed')),
  post_urn    text,
  error       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (digest_id, owner_email, platform)
);

comment on table public.social_link_post is
  'Per-founder, per-drop social post claim + result. Service-role only.';

alter table public.social_link_post enable row level security;