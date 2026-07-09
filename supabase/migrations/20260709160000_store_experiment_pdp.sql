-- Extend store_experiment to product-page tests: page_key was hard-checked to 'home'
-- (store studio v2, 20260705100000); the A/B system now also tests the PDP template
-- (challenger kind pdp_copy). One-running-per-shop stays as-is — a single experiment
-- at a time keeps checkout attribution unambiguous.
alter table public.store_experiment
  drop constraint if exists store_experiment_page_key_check;
alter table public.store_experiment
  add constraint store_experiment_page_key_check check (page_key in ('home', 'pdp'));
