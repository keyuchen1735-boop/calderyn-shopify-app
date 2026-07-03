-- Atomic over-refund guard + refund ledger append (platform pivot #3b). One SQL
-- function = one transaction, mirroring record_stripe_event: the refund executor
-- (app/lib/actions/refund.server.ts) calls this AFTER Stripe accepts the refund, to
-- record the money movement without a double/over-refund race.
--
-- Race safety: `select ... for update` on the payment_intent row serializes concurrent
-- refunds of the same order, so the sum-check below sees a consistent captured-vs-refunded
-- total (mirrors how record_stripe_event serializes on the PI). The unique(stripe_event_id,
-- kind) guard on transaction_ledger is the idempotency backstop — a replayed Stripe refund
-- id can never insert a second row, and the early idempotent-replay return below keeps the
-- over-refund guard from double-counting a refund that already landed.
--
-- Amount convention: p_amount_cents is the POSITIVE refund magnitude; the stored ledger row
-- is NEGATIVE (transaction_ledger.amount_cents is signed — capture positive, refund negative).
-- Raises (rolling back nothing it didn't itself write) on over-refund or an unresolved PI so
-- the executor surfaces it (rule 12) instead of silently drifting the ledger.
create or replace function public.record_refund_ledger(
  p_shop_id           uuid,
  p_payment_intent_id uuid,
  p_order_ref         text,
  p_amount_cents      bigint,   -- POSITIVE refund magnitude
  p_currency          text,
  p_stripe_ref        text,     -- charge ch_... / refund re_... that caused this entry
  p_stripe_event_id   text,     -- re_... refund id: the idempotency key for this ledger row
  p_occurred_at       timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_captured bigint;
  v_refunded bigint;
begin
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'refund amount must be a positive magnitude, got %', p_amount_cents;
  end if;

  -- Serialize concurrent refunds of the same PI (also the shop-ownership cross-check).
  perform 1 from public.payment_intent
  where id = p_payment_intent_id and shop_id = p_shop_id
  for update;
  if not found then
    raise exception 'payment_intent % not found for shop %', p_payment_intent_id, p_shop_id;
  end if;

  -- Idempotent replay: this exact refund already recorded -> return current totals, no re-guard.
  if exists (
    select 1 from public.transaction_ledger
    where payment_intent_id = p_payment_intent_id
      and kind = 'refund'
      and stripe_event_id = p_stripe_event_id
  ) then
    select coalesce(sum(amount_cents), 0) into v_captured
    from public.transaction_ledger
    where payment_intent_id = p_payment_intent_id and kind = 'capture';
    select coalesce(sum(-amount_cents), 0) into v_refunded
    from public.transaction_ledger
    where payment_intent_id = p_payment_intent_id and kind = 'refund';
    return jsonb_build_object(
      'captured_cents', v_captured,
      'refunded_cents', v_refunded,
      'fully_refunded', (v_captured > 0 and v_refunded >= v_captured),
      'inserted', false
    );
  end if;

  select coalesce(sum(amount_cents), 0) into v_captured
  from public.transaction_ledger
  where payment_intent_id = p_payment_intent_id and kind = 'capture';

  -- Only an order that actually captured money through the owned checkout can be refunded here.
  if v_captured <= 0 then
    raise exception 'payment_intent % has no captured amount to refund', p_payment_intent_id;
  end if;

  select coalesce(sum(-amount_cents), 0) into v_refunded
  from public.transaction_ledger
  where payment_intent_id = p_payment_intent_id and kind = 'refund';

  -- Atomic over-refund guard: cumulative refunds may never exceed the captured total.
  if v_refunded + p_amount_cents > v_captured then
    raise exception 'over-refund for payment_intent %: captured %, already refunded %, requested % (remaining %)',
      p_payment_intent_id, v_captured, v_refunded, p_amount_cents, v_captured - v_refunded;
  end if;

  insert into public.transaction_ledger (
    shop_id, payment_intent_id, order_ref, kind, amount_cents, currency,
    stripe_ref, stripe_event_id, occurred_at
  )
  values (
    p_shop_id, p_payment_intent_id, p_order_ref, 'refund', -p_amount_cents, p_currency,
    p_stripe_ref, p_stripe_event_id, p_occurred_at
  )
  on conflict (stripe_event_id, kind) do nothing;

  v_refunded := v_refunded + p_amount_cents;
  return jsonb_build_object(
    'captured_cents', v_captured,
    'refunded_cents', v_refunded,
    'fully_refunded', (v_refunded >= v_captured),
    'inserted', true
  );
end;
$$;

-- Money mutation: only the service role may call it (mirrors record_stripe_event hardening).
revoke execute on function public.record_refund_ledger(
  uuid, uuid, text, bigint, text, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.record_refund_ledger(
  uuid, uuid, text, bigint, text, text, text, timestamptz
) to service_role;
