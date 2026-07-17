-- Register the unchanged deploy-owned hero bytes for the newly approved
-- immutable recipe versions. Historical rows remain available for edits of
-- already-persisted releases.

insert into public.storefront_recipe_asset_registry
  (template_id, template_version, logical_key, content_hash, media_type, byte_size)
values
  ('custom-bench', 2, 'hero', 'f6f25c15de46bf6dd431ae685202f90fbbc3ba00e8051f6a6f4afaa8b89cdde9', 'image/webp', 132568),
  ('commons-index', 2, 'hero', '9201028ef1da24dd4318d0dafd8b4e18f32d16e12ba921c5ded28765b0cbaca1', 'image/webp', 130446),
  ('soft-chemistry', 2, 'hero', '4639c3cfe144d901162c2ede0053cd6174e26379460e3d63a3bef64f286f482f', 'image/webp', 40456),
  ('companion-field-guide', 2, 'hero', '305b7c4a9f43578032dba1e95a63869d9e17b370585c24438b7b963aa0a9a2d6', 'image/webp', 158522),
  ('daily-protocol', 2, 'hero', '798fb222ba0b6975c3f83d7d95f6640227f781b2e4582f758cc712a0f45a8054', 'image/webp', 81984),
  ('room-modes', 2, 'hero', 'ed779ae096effacc6af8a58f5ab55b79faad5ae2b3b5fba892b796e310586d30', 'image/webp', 80050),
  ('rep-rest', 2, 'hero', 'b404cf72b60022837096e1e8b02d539b5369a9ff09d4bda742378b7aae71d9c1', 'image/webp', 170844),
  ('diagnostic-deck', 2, 'hero', 'dca1f96a14f60dcc2b1305f84ac97b480f8007a25709ac9995eee71ac8e2db9e', 'image/webp', 101094),
  ('ritual-almanac', 2, 'hero', '747c24090ce37d341af9d22a7057f5830c26dc74181da0d82bb5aa07ffafe8f8', 'image/webp', 242494),
  ('broadcast-patch-bay', 2, 'hero', 'c95d86839d3b7efea39f439452011aaad78e4519e9928890246f67b0bf9f5363', 'image/webp', 78150),
  ('atelier-nine', 2, 'hero', 'bf43ff158ad36f2399f116949983f821578bec4e4bbf7baad34791604ac90fc9', 'image/webp', 44708),
  ('atelier-nine', 3, 'hero', 'bf43ff158ad36f2399f116949983f821578bec4e4bbf7baad34791604ac90fc9', 'image/webp', 44708)
on conflict (template_id, template_version, logical_key) do nothing;
