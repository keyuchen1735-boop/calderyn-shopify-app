-- supabase/migrations/20260430000024_super_admin_session.sql
-- Plan 04 Task 3: super_admin_session and super_admin_session_action link table.
-- Super-admin sessions are tracked per-shop so audit rows produced under them
-- can later be attributed and notified back to the merchant.

create table super_admin_session (
  id                     uuid primary key default gen_random_uuid(),
  shop_id                uuid not null references shops(id) on delete cascade,
  admin_email            text not null,
  reason                 text not null,
  approved_by            text,
  expires_at             timestamptz not null,
  revoked_at             timestamptz,
  notified_shop_owner_at timestamptz,
  created_at             timestamptz not null default now()
);
create index sas_shop_active_idx on super_admin_session (shop_id) where revoked_at is null;

alter table super_admin_session enable row level security;
create policy sas_shop_scope on super_admin_session
  using (shop_id = current_shop_id())
  with check (shop_id = current_shop_id());

create table super_admin_session_action (
  session_id uuid not null references super_admin_session(id) on delete cascade,
  audit_id   uuid not null references action_audit(id) on delete cascade,
  primary key (session_id, audit_id)
);

alter table super_admin_session_action enable row level security;
create policy sasa_shop_scope on super_admin_session_action
  using (
    exists (
      select 1
      from super_admin_session s
      where s.id = session_id
        and s.shop_id = current_shop_id()
    )
  )
  with check (
    exists (
      select 1
      from super_admin_session s
      where s.id = session_id
        and s.shop_id = current_shop_id()
    )
  );

-- Now that super_admin_session exists, attach the deferred FK from action_audit.
-- Plan 04 Task 1's migration 022 declared super_admin_session_id as a bare uuid
-- because the parent table didn't exist yet. This ALTER closes the integrity
-- gap so a deleted session nullifies the audit reference rather than leaving
-- a dangling pointer (the audit row stays for compliance; just unlinks).
alter table action_audit
  add constraint action_audit_super_admin_session_fk
  foreign key (super_admin_session_id)
  references super_admin_session(id)
  on delete set null;
