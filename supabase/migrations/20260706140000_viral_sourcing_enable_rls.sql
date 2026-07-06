-- #17 sourcing tables shipped with RLS disabled; every other table in this DB
-- has it on. Enable RLS with NO policies: service_role (ingest + all server
-- reads) bypasses RLS and keeps working; anon/authenticated are denied. This
-- matches the intended service-role-only access. Row policies for any future
-- merchant-facing read of sourced_product_link land with #12.
alter table public.supplier              enable row level security;
alter table public.source_product        enable row level security;
alter table public.source_product_signal enable row level security;
alter table public.source_product_score  enable row level security;
alter table public.sourced_product_link  enable row level security;
alter table public.sourcing_run          enable row level security;
