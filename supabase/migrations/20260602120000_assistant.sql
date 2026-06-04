-- assistant_conversations / assistant_messages: persisted chat history for the
-- in-app AI assistant. Shop-scoped in code (service-role); RLS deferred (spec §3).

create table assistant_conversations (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references shops(id) on delete cascade,
  title       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index assistant_conversations_shop_updated_idx
  on assistant_conversations (shop_id, updated_at desc);

create table assistant_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references assistant_conversations(id) on delete cascade,
  shop_id         uuid not null references shops(id) on delete cascade,
  role            text not null check (role in ('user','assistant')),
  content         text not null,
  drafted_action  jsonb,
  created_at      timestamptz not null default now()
);

create index assistant_messages_conversation_created_idx
  on assistant_messages (conversation_id, created_at);
