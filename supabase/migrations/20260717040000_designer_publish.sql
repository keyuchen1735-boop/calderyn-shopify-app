-- Designer: checkout becomes a designable page, and publishing gets a served
-- snapshot. Hidden Labs. Service-role only, RLS on for the new table.

-- Checkout joins the designable routes. It is preview/design only — the
-- transactional /storefront/checkout route always serves the real checkout;
-- the designer's checkout doc is never published or publicly served.
alter table designer_documents drop constraint if exists designer_documents_route_check;
alter table designer_documents add constraint designer_documents_route_check
  check (route in ('base','home','collection','product','search','cart','checkout'));

-- A published snapshot of the designer's display pages, served at the public
-- storefront URL. Draft docs (designer_documents) keep changing as the
-- merchant edits; only this snapshot is public, so editing never mutates the
-- live site until they publish again. Cart and checkout are never snapshotted
-- (the functional storefront routes serve those), and serving branches on a
-- cheap primary-key lookup here — absent rows mean the runtime serves as ever.
create table if not exists designer_publications (
  shop_id uuid not null references shops(id) on delete cascade,
  route text not null check (route in ('base','home','collection','product','search')),
  html text not null,
  css text not null,
  published_at timestamptz not null default now(),
  primary key (shop_id, route)
);
alter table designer_publications enable row level security;
