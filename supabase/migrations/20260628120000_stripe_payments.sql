-- Stripe payments spike (keepable thin slice): payment_intent + append-only
-- transaction_ledger + stripe_event idempotency log. App-owned warehouse tables
-- (not read by the Python engine -> supabase/migrations only, no engine mirror).
-- Money is integer cents. RLS mirrors refund_fact: service-role writes bypass RLS;
-- a current_shop_id() read policy is defense-in-depth for the authenticated path.

-- 1) payment_intent: one row per Stripe PaymentIntent, shop-scoped.
create table public.payment_intent (
  id           uuid primary key default gen_random_uuid(),
  shop_id      uuid not null references public.shops(id) on delete cascade,
  stripe_pi_id text not null,
  order_ref    text,                       -- ponytail: stubbed order linkage -> order_id FK in #2
  amount_cents integer not null,
  currency     text not null default 'usd',
  status       text not null default 'requires_payment_method',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (stripe_pi_id)
);
create index payment_intent_shop_idx on public.payment_intent (shop_id, created_at desc);

alter table public.payment_intent enable row level security;
create policy payment_intent_read on public.payment_intent
  for select using (shop_id = public.current_shop_id());

-- 2) transaction_ledger: append-only, signed amounts. Only 'capture' emitted in this slice.
create table public.transaction_ledger (
  id                uuid primary key default gen_random_uuid(),
  shop_id           uuid not null references public.shops(id) on delete cascade,
  payment_intent_id uuid references public.payment_intent(id) on delete restrict,
  order_ref         text,                  -- ponytail: mirrors payment_intent.order_ref -> order_id in #2
  kind              text not null check (kind in ('auth','capture','refund','fee','payout')),
  amount_cents      bigint not null,       -- SIGNED: capture positive; refund/fee/payout negative when they land
  currency          text not null,
  stripe_ref        text not null,         -- charge ch_... or pi_... that caused this entry
  stripe_event_id   text not null,         -- evt_... that produced this row
  occurred_at       timestamptz not null,  -- Stripe event.created
  created_at        timestamptz not null default now(),
  unique (stripe_event_id, kind)           -- secondary idempotency guard (defense-in-depth)
);
create index transaction_ledger_pi_idx on public.transaction_ledger (payment_intent_id);

alter table public.transaction_ledger enable row level security;
create policy transaction_ledger_read on public.transaction_ledger
  for select using (shop_id = public.current_shop_id());

-- 3) stripe_event: idempotency log, mirrors raw_shopify_webhook.unique(webhook_id).
create table public.stripe_event (
  id                 bigserial primary key,
  shop_id            uuid not null references public.shops(id) on delete cascade,
  stripe_event_id    text not null,
  type               text not null,
  signature_verified boolean not null,
  received_at        timestamptz not null default now(),
  payload            jsonb not null,
  unique (stripe_event_id)                 -- PRIMARY idempotency key
);

alter table public.stripe_event enable row level security;
create policy stripe_event_read on public.stripe_event
  for select using (shop_id = public.current_shop_id());

-- 4) Atomic record-or-skip: one SQL function = one transaction. Mirrors the
-- raw_shopify_webhook 23505-tolerant pattern, made atomic for the multi-table write.
-- Returns true on first delivery (event recorded + side effects applied),
-- false on a duplicate (whole call is a no-op). Raises (rolling back the event
-- marker) if the PI/shop can't be resolved -> fail visibly (rule 12).
create or replace function public.record_stripe_event(
  p_event_id           text,
  p_type               text,
  p_shop_id            uuid,
  p_signature_verified boolean,
  p_payload            jsonb,
  p_stripe_pi_id       text,
  p_new_status         text,
  p_kind               text,        -- 'capture' for succeeded; null for failed/no-money events
  p_amount_cents       bigint,      -- ledger amount; null when no ledger row
  p_currency           text,
  p_stripe_ref         text,
  p_occurred_at        timestamptz
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pi_id uuid;
begin
  insert into public.stripe_event (shop_id, stripe_event_id, type, signature_verified, payload)
  values (p_shop_id, p_event_id, p_type, p_signature_verified, p_payload)
  on conflict (stripe_event_id) do nothing;

  -- 23505 / on-conflict: this event already landed -> the whole call is a no-op.
  if not found then
    return false;
  end if;

  -- First delivery: resolve the shop-scoped PI and cross-check the tenant.
  select id into v_pi_id
  from public.payment_intent
  where stripe_pi_id = p_stripe_pi_id and shop_id = p_shop_id;

  if v_pi_id is null then
    raise exception 'payment_intent % not found for shop %', p_stripe_pi_id, p_shop_id;
  end if;

  -- Money moved -> append exactly one ledger row (idempotent on retry via the unique guard).
  if p_kind is not null then
    insert into public.transaction_ledger (
      shop_id, payment_intent_id, order_ref, kind, amount_cents, currency,
      stripe_ref, stripe_event_id, occurred_at
    )
    select p_shop_id, v_pi_id, pi.order_ref, p_kind, p_amount_cents, p_currency,
           p_stripe_ref, p_event_id, p_occurred_at
    from public.payment_intent pi
    where pi.id = v_pi_id
    on conflict (stripe_event_id, kind) do nothing;
  end if;

  update public.payment_intent
  set status = p_new_status, updated_at = now()
  where id = v_pi_id;

  return true;
end;
$$;

-- Money mutation: only the service role may call it (mirrors revoke_anon_rpc_execute hardening).
revoke execute on function public.record_stripe_event(
  text, text, uuid, boolean, jsonb, text, text, text, bigint, text, text, timestamptz
) from public, anon, authenticated;

-- service_role is not the function owner and BYPASSRLS does not grant EXECUTE, so the
-- webhook (service-role client) needs an explicit grant or every rpc() call fails closed.
grant execute on function public.record_stripe_event(
  text, text, uuid, boolean, jsonb, text, text, text, bigint, text, text, timestamptz
) to service_role;
