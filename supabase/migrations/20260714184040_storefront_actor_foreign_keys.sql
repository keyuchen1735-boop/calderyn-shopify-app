alter table public.storefront_release_history
  drop constraint storefront_release_history_actor_id_fkey,
  add constraint storefront_release_history_actor_id_fkey
    foreign key (actor_id) references public.users(id) on delete set null;

alter table public.storefront_bundle_edit
  drop constraint storefront_bundle_edit_actor_id_fkey,
  add constraint storefront_bundle_edit_actor_id_fkey
    foreign key (actor_id) references public.users(id) on delete set null;
