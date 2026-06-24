alter table public.sku_dim
  add column if not exists inventory_policy text
    check (inventory_policy is null or inventory_policy in ('deny', 'continue')),
  add column if not exists inventory_tracked boolean;
