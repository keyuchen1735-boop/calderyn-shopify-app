-- bug_report: merchant-submitted reports from the "Report a bug" launcher on both
-- surfaces (embedded Shopify app + dashboard). Each row is emailed to the team
-- (reply-to the merchant) and kept here as the durable record so a failed send is
-- never lost. Screenshots live in the private `bug-reports` storage bucket;
-- `attachments` records their object paths.
--
-- Shop-scoped via shop_id FK ON DELETE CASCADE to honour the GDPR-redact schema
-- invariant (every per-shop table cascades from shops). RLS on with no policy: the
-- app reaches this table only via the service-role key (which bypasses RLS);
-- anon/authenticated are denied. Mirrors the oauth_state / integration_credentials
-- convention.

create table if not exists public.bug_report (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  shop_id        uuid not null references shops(id) on delete cascade,
  shop_domain    text not null,
  reporter_email text not null,
  description    text not null,
  surface        text not null,
  context        jsonb not null default '{}'::jsonb,
  attachments    jsonb not null default '[]'::jsonb,
  email_status   text not null,
  email_error    text
);

create index if not exists bug_report_shop_idx on public.bug_report (shop_id, created_at desc);

alter table public.bug_report enable row level security;
revoke all on table public.bug_report from anon, authenticated;

-- Private bucket for screenshots. Service-role uploads bypass Storage RLS; with no
-- storage.objects policy for this bucket, anon/authenticated cannot read it.
insert into storage.buckets (id, name, public)
values ('bug-reports', 'bug-reports', false)
on conflict (id) do nothing;
