-- From-scratch designer engine (hidden Labs): each shop's design is a plain
-- HTML/CSS document per route that the model edits directly, plus a rolling
-- chat context. Service-role access only, RLS enabled with no anon policies
-- (matches the storefront bundle tables).
create table if not exists designer_documents (
  shop_id uuid not null references shops(id) on delete cascade,
  route text not null check (route in ('base','home','collection','product','search','cart')),
  html text not null,
  css text not null,
  template_id text not null,
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  primary key (shop_id, route)
);
alter table designer_documents enable row level security;

create table if not exists designer_chat (
  id bigint generated always as identity primary key,
  shop_id uuid not null references shops(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists designer_chat_shop_created on designer_chat (shop_id, created_at desc);
alter table designer_chat enable row level security;
