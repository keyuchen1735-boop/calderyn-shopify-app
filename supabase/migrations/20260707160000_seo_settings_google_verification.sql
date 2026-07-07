-- Google Search Console site-verification token. When set, the storefront home
-- serves <meta name="google-site-verification" content="..."> so a merchant can
-- verify ownership via the HTML-tag method without editing any code. Nullable:
-- absent = no tag emitted (the default).
alter table public.seo_settings
  add column if not exists google_site_verification text;
