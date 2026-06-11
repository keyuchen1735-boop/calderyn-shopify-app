-- Shop-scoped read access for dashboard Realtime subscriptions.
-- The dashboard backend mints short-lived JWTs (role=authenticated) carrying a
-- `shop_id` claim; these policies let that JWT SELECT only its shop's rows.
-- Service-role access (app, MCP, crons) bypasses RLS and is unaffected.

alter table public.alerts enable row level security;
alter table public.action_audit enable row level security;
alter table public.ad_campaign_dim enable row level security;

drop policy if exists dashboard_read_alerts on public.alerts;
create policy dashboard_read_alerts on public.alerts
  for select to authenticated
  using (shop_id = (auth.jwt() ->> 'shop_id')::uuid);

drop policy if exists dashboard_read_action_audit on public.action_audit;
create policy dashboard_read_action_audit on public.action_audit
  for select to authenticated
  using (shop_id = (auth.jwt() ->> 'shop_id')::uuid);

drop policy if exists dashboard_read_ad_campaign_dim on public.ad_campaign_dim;
create policy dashboard_read_ad_campaign_dim on public.ad_campaign_dim
  for select to authenticated
  using (shop_id = (auth.jwt() ->> 'shop_id')::uuid);

-- Realtime publication (idempotent adds).
do $$
begin
  begin
    alter publication supabase_realtime add table public.alerts;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.action_audit;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.ad_campaign_dim;
  exception when duplicate_object then null;
  end;
end $$;
