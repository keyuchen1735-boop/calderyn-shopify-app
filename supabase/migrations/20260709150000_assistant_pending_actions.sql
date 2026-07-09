-- supabase/migrations/20260709150000_assistant_pending_actions.sql
-- Tier-2 assistant actions awaiting merchant confirmation. The confirm route
-- executes by id only; parameters live here server-side, never in the client.
create table if not exists assistant_pending_actions (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null,
  conversation_id uuid not null,
  action text not null,
  input jsonb not null default '{}'::jsonb,
  summary text not null,
  status text not null default 'pending'
    check (status in ('pending', 'executed', 'dismissed', 'expired')),
  executed_audit_id text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists assistant_pending_actions_shop_conv_idx
  on assistant_pending_actions (shop_id, conversation_id, status);

alter table assistant_pending_actions enable row level security;
-- Service-role only (same posture as assistant_conversations/messages):
-- no anon/authenticated policies on purpose.

-- Receipts + pending card ride on the assistant message that produced them.
alter table assistant_messages add column if not exists receipts jsonb;
alter table assistant_messages add column if not exists pending_action jsonb;
