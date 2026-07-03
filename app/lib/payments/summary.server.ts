// Dashboard read-model over the Stripe payments spine (payment_intent +
// transaction_ledger). Service-role reads threaded by shop_id, shaped into
// DTOs — Supabase rows never leak to the client.
import { getSupabase } from "~/lib/supabase.server";
import type { LedgerRow, PaymentsPage, PaymentsSummary, PendingIntentRow } from "./summary-types";

export type { LedgerRow, PaymentsPage, PaymentsSummary, PendingIntentRow };

const TXN_LIMIT = 50;
const PENDING_LIMIT = 50;
// Cap on the 30-day aggregation read. Far above pilot volume; if a shop ever
// exceeds it the sums degrade to a floor rather than failing the screen.
const WINDOW_ROW_CAP = 10_000;
const WINDOW_MS = 30 * 86_400_000;

const LEDGER_KINDS = ["auth", "capture", "refund", "fee", "payout"] as const;

function isLedgerKind(v: string): v is LedgerRow["kind"] {
  return (LEDGER_KINDS as readonly string[]).includes(v);
}

/** 30-day totals by ledger kind, absolute cents (the ledger stores refunds/
 *  fees/payouts as negative amounts; the dashboard reports magnitudes). */
async function windowTotals(shopId: string): Promise<{
  grossVolumeCents30d: number;
  txnCount30d: number;
  refundCents30d: number;
  feeCents30d: number;
  payoutCents30d: number;
}> {
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const { data, error } = await getSupabase()
    .from("transaction_ledger")
    .select("kind, amount_cents")
    .eq("shop_id", shopId)
    .gte("occurred_at", since)
    .order("occurred_at", { ascending: false })
    .limit(WINDOW_ROW_CAP);
  if (error) throw new Error(`transaction_ledger read failed: ${error.message}`);
  if ((data ?? []).length >= WINDOW_ROW_CAP) {
    // The floor is deliberate (the screen must not fail at volume) but never
    // silent: at this size the sums belong in a SQL aggregate.
    console.warn(
      `[payments.summary] 30d ledger window capped at ${WINDOW_ROW_CAP} rows for shop ${shopId}; volume stats under-report`,
    );
  }

  let gross = 0;
  let captures = 0;
  let refund = 0;
  let fee = 0;
  let payout = 0;
  for (const r of data ?? []) {
    const amount = Math.abs(Number(r.amount_cents ?? 0));
    switch (String(r.kind)) {
      case "capture":
        gross += amount;
        captures += 1;
        break;
      case "refund":
        refund += amount;
        break;
      case "fee":
        fee += amount;
        break;
      case "payout":
        payout += amount;
        break;
    }
  }
  return {
    grossVolumeCents30d: gross,
    txnCount30d: captures,
    refundCents30d: refund,
    feeCents30d: fee,
    payoutCents30d: payout,
  };
}

/** PaymentIntents still in flight — anything not succeeded or canceled. */
async function listPendingIntents(shopId: string): Promise<PendingIntentRow[]> {
  const { data, error } = await getSupabase()
    .from("payment_intent")
    .select("id, stripe_pi_id, order_ref, amount_cents, currency, status, created_at")
    .eq("shop_id", shopId)
    .not("status", "in", "(succeeded,canceled)")
    .order("created_at", { ascending: false })
    .limit(PENDING_LIMIT);
  if (error) throw new Error(`payment_intent read failed: ${error.message}`);
  return (data ?? []).map((r) => ({
    id: String(r.id),
    stripePiId: String(r.stripe_pi_id),
    orderRef: r.order_ref == null ? null : String(r.order_ref),
    amountCents: Number(r.amount_cents ?? 0),
    currency: String(r.currency ?? "usd"),
    status: String(r.status),
    createdAt: String(r.created_at),
  }));
}

/** Latest ledger entries, newest first, signed amounts as stored. */
async function listTransactions(shopId: string): Promise<LedgerRow[]> {
  const { data, error } = await getSupabase()
    .from("transaction_ledger")
    .select("id, kind, amount_cents, currency, order_ref, stripe_ref, occurred_at")
    .eq("shop_id", shopId)
    .order("occurred_at", { ascending: false })
    .limit(TXN_LIMIT);
  if (error) throw new Error(`transaction_ledger read failed: ${error.message}`);
  const rows: LedgerRow[] = [];
  for (const r of data ?? []) {
    const kind = String(r.kind);
    // The DB check constraint guarantees the kind set; skipping an unknown
    // value (rather than mislabeling it) keeps the DTO union honest.
    if (!isLedgerKind(kind)) continue;
    rows.push({
      id: String(r.id),
      kind,
      amountCents: Number(r.amount_cents ?? 0),
      currency: String(r.currency ?? "usd"),
      orderRef: r.order_ref == null ? null : String(r.order_ref),
      stripeRef: r.stripe_ref == null ? null : String(r.stripe_ref),
      occurredAt: String(r.occurred_at),
    });
  }
  return rows;
}

export async function loadPaymentsPage(shopId: string): Promise<PaymentsPage> {
  const [totals, pendingIntents, transactions] = await Promise.all([
    windowTotals(shopId),
    listPendingIntents(shopId),
    listTransactions(shopId),
  ]);
  const refundRatePct =
    totals.grossVolumeCents30d > 0
      ? (totals.refundCents30d / totals.grossVolumeCents30d) * 100
      : null;
  return {
    summary: { ...totals, refundRatePct, pendingIntents },
    transactions,
  };
}
