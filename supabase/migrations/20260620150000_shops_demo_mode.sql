-- Per-shop "showcase mode" flag.
--
-- A demo/showcase store (demo_mode = true) is seeded with synthetic campaigns
-- and inventory that have no live object on Meta/Google/TikTok/Shopify. For such
-- a shop the action executors record the intended result WITHOUT making the
-- external platform call (which would 404 on the synthetic ids and surface an
-- error mid-demo). See app/lib/demo/showcase.server.ts.
--
-- Default false: every real merchant shop is unaffected and continues to execute
-- against the live platforms. Never set true on a real merchant shop.
alter table shops add column if not exists demo_mode boolean not null default false;

comment on column shops.demo_mode is
  'Showcase/demo store: action executors simulate the external platform side effect (see app/lib/demo/showcase.server.ts). Never set on a real merchant shop.';
