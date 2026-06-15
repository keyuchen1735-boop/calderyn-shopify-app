-- Pilot onboarding invite send log (app/routes/pilot.api.send-invite). One row per
-- send attempt so the admin /panel can render invited/failed status and avoid
-- double-sends. Written only via the service-role key (BYPASSRLS); RLS on + grants
-- revoked so the anon/authenticated PostgREST roles get nothing (mirrors the
-- mcp_tokens / oauth_state convention). email/first_name/store_name are PII —
-- service-role only, never exposed to the public anon key.
create table if not exists public.pilot_invites (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  first_name  text not null,
  store_name  text not null,
  status      text not null check (status in ('sent','failed')),
  resend_id   text,
  error       text,
  created_at  timestamptz not null default now()
);
create index if not exists pilot_invites_email_idx     on public.pilot_invites (lower(email));
create index if not exists pilot_invites_created_at_idx on public.pilot_invites (created_at desc);
alter table public.pilot_invites enable row level security;
revoke all on table public.pilot_invites from anon, authenticated;
