-- Hidden per-shop switch for the template-composition storefront builder
-- (Labs). Off by default; the compose API refuses shops that have not opted in.
alter table store_settings
  add column if not exists composer_enabled boolean not null default false;
