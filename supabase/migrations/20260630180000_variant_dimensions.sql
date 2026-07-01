-- Owned-variant package dimensions (platform pivot #5-shipping). Metric integers,
-- consistent with the existing variant_dim.grams weight; the shipping quote engine
-- converts to inches/ounces at read time. Additive + nullable, so existing variants
-- and readers are unaffected; presence is validated softly (a shippable variant may
-- lack dimensions and quote at low confidence).
alter table public.variant_dim
  add column if not exists length_mm integer,
  add column if not exists width_mm integer,
  add column if not exists height_mm integer;
