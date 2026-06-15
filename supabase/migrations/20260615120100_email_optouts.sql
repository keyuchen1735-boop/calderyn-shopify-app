-- Email suppression list for pilot sends. The RFC 8058 one-click unsubscribe
-- (app/routes/pilot.unsubscribe) writes here, and the send endpoint refuses any
-- address present (fail closed). Service-role only: RLS on + grants revoked
-- (mirrors the mcp_tokens / oauth_state convention).
create table if not exists public.email_optouts (
  email       text primary key,        -- stored lowercased
  reason      text,
  source      text not null default 'pilot',
  created_at  timestamptz not null default now()
);
alter table public.email_optouts enable row level security;
revoke all on table public.email_optouts from anon, authenticated;
