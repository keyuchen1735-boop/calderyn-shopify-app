// DTO shapes shared by the payments read model (summary.server.ts) and the
// dashboard client/screen. Plain types only — safe to import from the browser.

/** A payment_intent still in flight (status not in succeeded/canceled). */
export interface PendingIntentRow {
  id: string;
  stripePiId: string;
  orderRef: string | null;
  amountCents: number;
  currency: string;
  status: string;
  createdAt: string;
}

export interface PaymentsSummary {
  /** Sum of 'capture' ledger amounts over the last 30 days, absolute cents. */
  grossVolumeCents30d: number;
  /** Number of 'capture' ledger rows over the last 30 days. */
  txnCount30d: number;
  /** Absolute sum of 'refund' ledger amounts over the last 30 days, cents. */
  refundCents30d: number;
  /** Refund volume as a percentage of capture volume; null when no captures. */
  refundRatePct: number | null;
  /** Absolute sum of 'fee' ledger amounts over the last 30 days, cents. */
  feeCents30d: number;
  /** Absolute sum of 'payout' ledger amounts over the last 30 days, cents. */
  payoutCents30d: number;
  pendingIntents: PendingIntentRow[];
}

/** One transaction_ledger row. amountCents keeps the ledger's sign (capture
 *  positive; refund/fee/payout negative as they land). */
export interface LedgerRow {
  id: string;
  kind: "auth" | "capture" | "refund" | "fee" | "payout";
  amountCents: number;
  currency: string;
  orderRef: string | null;
  stripeRef: string | null;
  occurredAt: string;
}

export interface PaymentsPage {
  summary: PaymentsSummary;
  transactions: LedgerRow[];
}
