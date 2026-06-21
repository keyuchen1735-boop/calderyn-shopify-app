-- Social digest: one row per weekly drop, tracking the approve/reject/regenerate
-- lifecycle for the LinkedIn + Instagram carousels. Accessed only by the app via
-- the Supabase service-role key, so RLS is enabled with no policies (service role
-- bypasses RLS; anon/authenticated get no access).

create table if not exists public.social_digest (
  id               uuid primary key default gen_random_uuid(),
  week_range       text        not null,
  since_iso        timestamptz not null,
  status           text        not null default 'pending'
                     check (status in ('pending', 'regenerating', 'posted', 'failed')),
  regen_count      int         not null default 0,
  pack_json        jsonb       not null,
  li_image_paths   text[]      not null default '{}',
  ig_image_paths   text[]      not null default '{}',
  li_caption       text        not null default '',
  ig_caption       text        not null default '',
  prior_copy_json  jsonb       not null default '[]'::jsonb,
  post_results_json jsonb,
  consumed_at      timestamptz,
  created_at       timestamptz not null default now(),
  acted_at         timestamptz
);

comment on table public.social_digest is
  'Weekly social carousel drops + approve/reject/regenerate state. Service-role only.';

create index if not exists social_digest_created_idx on public.social_digest (created_at desc);

alter table public.social_digest enable row level security;

-- Private storage bucket for the rendered slide PNGs (service-role only).
insert into storage.buckets (id, name, public)
values ('social-digest', 'social-digest', false)
on conflict (id) do nothing;
