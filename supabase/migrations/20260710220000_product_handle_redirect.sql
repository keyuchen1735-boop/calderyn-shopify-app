-- Product handle redirects: when a merchant edits a product's URL handle, the
-- old handle keeps working — the storefront PDP looks it up here on a miss and
-- 301s to the product's current handle. One row per (shop, old_handle); a
-- reclaimed handle (renamed back onto a live product) deletes its row so a live
-- URL never redirects. RLS follows the seo_page shop-scope convention
-- (self-contained via public.current_shop_id(); service-role writes bypass RLS).

create table if not exists public.product_handle_redirect (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  old_handle text not null,
  product_id uuid not null references public.product_dim(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (shop_id, old_handle)
);
create index if not exists product_handle_redirect_product_idx
  on public.product_handle_redirect(product_id);

alter table public.product_handle_redirect enable row level security;
drop policy if exists product_handle_redirect_shop_scope on public.product_handle_redirect;
create policy product_handle_redirect_shop_scope on public.product_handle_redirect
  for all
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
revoke all on table public.product_handle_redirect from anon, authenticated;
grant select on table public.product_handle_redirect to app_web;

-- Self-test: RLS must be enabled, or fail the apply (seo_page convention).
do $$
begin
  if not exists (
    select 1 from pg_tables
    where schemaname = 'public' and tablename = 'product_handle_redirect' and rowsecurity = true
  ) then
    raise exception 'product_handle_redirect is missing RLS';
  end if;
end $$;
