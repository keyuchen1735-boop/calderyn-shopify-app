-- supabase/migrations/020_alerts_and_context.sql
-- Plan 03 Task 1: alerts, alert_context, alert_feedback, alert_thresholds
-- with row-level security scoped via current_shop_id().

create type alert_status as enum ('open', 'acknowledged', 'resolved', 'snoozed', 'dismissed');
create type alert_severity as enum ('low', 'medium', 'high', 'critical');

create table alerts (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references shops(id) on delete cascade,
  detector_id   text not null,
  entity_ref    jsonb not null,
  status        alert_status not null default 'open',
  severity      alert_severity not null default 'medium',
  dollar_impact numeric(12, 2) not null default 0,
  day_bucket    date not null,
  claude_narrative text,
  claude_rank   int,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  resolved_at   timestamptz,
  unique (shop_id, detector_id, entity_ref, day_bucket)
);
create index alerts_shop_status_idx on alerts (shop_id, status, last_seen_at desc);
create index alerts_detector_idx on alerts (shop_id, detector_id, day_bucket desc);

alter table alerts enable row level security;
create policy alerts_shop_scope on alerts
  using (shop_id = current_shop_id())
  with check (shop_id = current_shop_id());

create table alert_context (
  alert_id   uuid primary key references alerts(id) on delete cascade,
  shop_id    uuid not null references shops(id) on delete cascade,
  evidence   jsonb not null,
  created_at timestamptz not null default now()
);
alter table alert_context enable row level security;
create policy alert_context_shop_scope on alert_context
  using (shop_id = current_shop_id())
  with check (shop_id = current_shop_id());

create type feedback_kind as enum ('confirmed_loss', 'false_positive', 'already_handled');
create table alert_feedback (
  id         uuid primary key default gen_random_uuid(),
  alert_id   uuid not null references alerts(id) on delete cascade,
  shop_id    uuid not null references shops(id) on delete cascade,
  kind       feedback_kind not null,
  note       text,
  created_by text,
  created_at timestamptz not null default now()
);
alter table alert_feedback enable row level security;
create policy alert_feedback_shop_scope on alert_feedback
  using (shop_id = current_shop_id())
  with check (shop_id = current_shop_id());

create table alert_thresholds (
  shop_id      uuid not null references shops(id) on delete cascade,
  detector_id  text not null,
  threshold_json jsonb not null,
  updated_at   timestamptz not null default now(),
  primary key (shop_id, detector_id)
);
alter table alert_thresholds enable row level security;
create policy alert_thresholds_shop_scope on alert_thresholds
  using (shop_id = current_shop_id())
  with check (shop_id = current_shop_id());
