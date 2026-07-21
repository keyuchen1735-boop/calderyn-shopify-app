-- Public-read, service-role-written immutable media for native storefront recipes.
insert into storage.buckets (id, name, public)
values ('storefront-recipe-assets', 'storefront-recipe-assets', true)
on conflict (id) do update set public = true;

create policy "Public storefront recipe asset reads"
on storage.objects for select
to anon, authenticated
using (bucket_id = 'storefront-recipe-assets');
