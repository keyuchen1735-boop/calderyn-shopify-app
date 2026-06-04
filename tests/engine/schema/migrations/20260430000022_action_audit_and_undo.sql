-- supabase/migrations/20260430000022_action_audit_and_undo.sql
-- Plan 04 Task 1: action_audit, undo_token, action_idempotency
-- with row-level security scoped via current_shop_id().

create type action_kind as enum (
  'pause_campaign',
  'reduce_campaign_budget',
  'exclude_geo',
  'reallocate_inventory',
  'create_po_draft',
  'snooze_alert'
);

create type action_outcome as enum ('succeeded', 'failed', 'pending', 'retrying');

create table action_audit (
  id                     uuid primary key default gen_random_uuid(),
  shop_id                uuid not null references shops(id) on delete cascade,
  alert_id               uuid references alerts(id) on delete set null,
  action_kind            action_kind not null,
  params                 jsonb not null,
  outcome                action_outcome not null default 'pending',
  pre_state              jsonb,
  post_state             jsonb,
  external_call_id       text,
  last_error             text,
  attempts               int not null default 1,
  actor_user_id          text,
  actor_is_super_admin   boolean not null default false,
  super_admin_session_id uuid,
  undo_of                uuid references action_audit(id),
  dollar_impact_at_exec  numeric(12, 2),
  created_at             timestamptz not null default now(),
  completed_at           timestamptz
);
create index action_audit_shop_created_idx on action_audit (shop_id, created_at desc);
create index action_audit_alert_idx on action_audit (shop_id, alert_id);

alter table action_audit enable row level security;
create policy action_audit_shop_scope on action_audit
  using (shop_id = current_shop_id())
  with check (shop_id = current_shop_id());

create table undo_token (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references shops(id) on delete cascade,
  audit_id    uuid not null references action_audit(id) on delete cascade,
  expires_at  timestamptz not null,
  consumed_at timestamptz,
  created_at  timestamptz not null default now()
);
create index undo_token_shop_audit_idx on undo_token (shop_id, audit_id);

alter table undo_token enable row level security;
create policy undo_token_shop_scope on undo_token
  using (shop_id = current_shop_id())
  with check (shop_id = current_shop_id());

create table action_idempotency (
  shop_id         uuid not null references shops(id) on delete cascade,
  idempotency_key text not null,
  audit_id        uuid not null references action_audit(id) on delete cascade,
  created_at      timestamptz not null default now(),
  primary key (shop_id, idempotency_key)
);

alter table action_idempotency enable row level security;
create policy action_idempotency_shop_scope on action_idempotency
  using (shop_id = current_shop_id())
  with check (shop_id = current_shop_id());
