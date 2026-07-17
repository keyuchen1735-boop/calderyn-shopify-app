create function public.publish_storefront_runtime1_release(
  p_shop_id uuid,
  p_expected_draft_version_id uuid,
  p_expected_published_version_id uuid,
  p_actor_id uuid default null
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_current_draft uuid;
  v_current_published uuid;
  v_rows integer;
begin
  perform public.lock_storefront_design_shop(p_shop_id);
  perform public.storefront_assert_no_running_experiment(p_shop_id);
  insert into public.storefront_release (shop_id) values (p_shop_id)
    on conflict (shop_id) do nothing;
  select draft_version_id, published_version_id
    into v_current_draft, v_current_published
    from public.storefront_release
    where shop_id = p_shop_id
    for update;
  if v_current_draft is distinct from p_expected_draft_version_id
    or v_current_published is distinct from p_expected_published_version_id then
    raise exception using errcode = '40001', message = 'storefront_publish_conflict';
  end if;
  perform 1 from public.storefront_bundle_version
    where shop_id = p_shop_id
      and id = p_expected_draft_version_id
      and runtime_version = 1;
  if not found then
    raise exception using errcode = '23514', message = 'storefront_runtime1_release_required';
  end if;
  perform public.storefront_assert_installable(p_shop_id, p_expected_draft_version_id);
  update public.storefront_release
    set published_version_id = p_expected_draft_version_id, updated_at = now()
    where shop_id = p_shop_id
      and draft_version_id is not distinct from p_expected_draft_version_id
      and published_version_id is not distinct from p_expected_published_version_id;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception using errcode = '40001', message = 'storefront_publish_conflict';
  end if;
  insert into public.storefront_release_history (
    shop_id, from_version_id, to_version_id, operation, actor_id
  ) values (
    p_shop_id, p_expected_published_version_id, p_expected_draft_version_id, 'publish', p_actor_id
  );
  return p_expected_draft_version_id;
end;
$$;

create function public.storefront_runtime1_release_pointer_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if (tg_op = 'INSERT' or new.draft_version_id is distinct from old.draft_version_id)
    and new.draft_version_id is not null
    and not exists (
      select 1 from public.storefront_bundle_version
      where shop_id = new.shop_id and id = new.draft_version_id and runtime_version = 1
    ) then
    raise exception using errcode = '23514', message = 'storefront_runtime1_release_required';
  end if;
  if (tg_op = 'INSERT' or new.published_version_id is distinct from old.published_version_id)
    and new.published_version_id is not null
    and not exists (
      select 1 from public.storefront_bundle_version
      where shop_id = new.shop_id and id = new.published_version_id and runtime_version = 1
    ) then
    raise exception using errcode = '23514', message = 'storefront_runtime1_release_required';
  end if;
  return new;
end;
$$;

create trigger storefront_runtime1_release_pointer_guard
before insert or update on public.storefront_release
for each row execute function public.storefront_runtime1_release_pointer_guard();

revoke all on function public.storefront_runtime1_release_pointer_guard()
  from public, anon, authenticated;

revoke execute on function public.prepare_storefront_legacy_capture(uuid) from service_role;
revoke execute on function public.capture_storefront_legacy_release(uuid, uuid, jsonb, jsonb, text, jsonb, text) from service_role;
revoke execute on function public.publish_storefront_release(uuid, uuid, uuid, uuid, jsonb, jsonb, text, jsonb, text) from service_role;

revoke all on function public.publish_storefront_runtime1_release(uuid, uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.publish_storefront_runtime1_release(uuid, uuid, uuid, uuid)
  to service_role;
