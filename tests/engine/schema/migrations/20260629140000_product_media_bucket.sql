-- Private bucket for owned-catalog product images (Slice 1). Service-role writes
-- via getSupabase(); reads are served through signed URLs minted server-side.
insert into storage.buckets (id, name, public)
values ('product-media', 'product-media', false)
on conflict (id) do nothing;
