-- Slice 0 auth follow-ups: Google identity (password optional), email
-- verification flag, and a 'verify' purpose for the reset-token table.
-- Idempotent + dual-run safe (existing email+password users keep a password_hash
-- and email_verified defaults false; the verify gate only applies to first-party
-- sessions). The dashboard_sessions / shops contracts are untouched.

-- Google-only users have no password.
alter table public.users alter column password_hash drop not null;

-- Google account identifier (the OIDC 'sub'); unique among non-null values.
alter table public.users add column if not exists google_sub text;
create unique index if not exists users_google_sub_key
  on public.users(google_sub) where google_sub is not null;

-- Email verification flag (default false; flipped by the verify route).
alter table public.users add column if not exists email_verified boolean not null default false;

-- Every user must have at least one credential (a password or a Google identity).
do $$
begin
  if not exists (
    select 1 from pg_constraint c
    join pg_class r on r.oid = c.conrelid
    where c.conname = 'users_has_credential'
      and r.relname = 'users'
      and r.relnamespace = 'public'::regnamespace
  ) then
    alter table public.users
      add constraint users_has_credential
      check (password_hash is not null or google_sub is not null) not valid;
    alter table public.users validate constraint users_has_credential;
  end if;
end $$;

-- Allow the verification token purpose alongside reset / set_password.
do $$
begin
  alter table public.password_reset_token drop constraint if exists password_reset_token_purpose_check;
  alter table public.password_reset_token
    add constraint password_reset_token_purpose_check
    check (purpose in ('reset','set_password','verify'));
end $$;
