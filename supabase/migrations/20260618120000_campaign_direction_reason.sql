-- campaign_direction_reason: caches the ONE plain-English sentence shown for a
-- campaign's recommended direction, so Claude is called at most once per campaign
-- per day per direction. `as_of_date` is the UTC date the reason was generated;
-- when the direction flips intraday the (…, direction) key changes and we re-phrase.
-- `source` = 'claude' | 'template' (the deterministic fallback). Shop-scoped in
-- code (service-role); deny-by-default RLS like every other table.

create table campaign_direction_reason (
  shop_id     uuid        not null references shops(id) on delete cascade,
  campaign_id text        not null,
  as_of_date  date        not null,
  direction   text        not null
                check (direction in ('scale_up','scale_down','keep','pause')),
  reason      text        not null,
  source      text        not null check (source in ('claude','template')),
  model       text,
  created_at  timestamptz not null default now(),
  primary key (shop_id, campaign_id, as_of_date, direction)
);

alter table campaign_direction_reason enable row level security;
