-- Generated imagery for the designer engine (hidden Labs): one row per named
-- asset (e.g. 'hero') per shop, resolved by the renderer through the
-- {{asset.<key>}} placeholder. URLs point at owned storage (persisted from
-- Gemini output) so the storefront CSP allows them. Service-role only.
create table if not exists designer_assets (
  shop_id uuid not null references shops(id) on delete cascade,
  key text not null check (key ~ '^[a-z0-9_-]{1,40}$'),
  url text not null,
  prompt text not null default '',
  created_at timestamptz not null default now(),
  primary key (shop_id, key)
);
alter table designer_assets enable row level security;
