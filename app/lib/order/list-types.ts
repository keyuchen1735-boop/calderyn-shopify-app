// DTO shapes shared by the owned-orders read model (list.server.ts) and the
// dashboard client/screen. Plain types only — safe to import from the browser.

export interface OrderRow {
  id: string;
  ref: string;
  buyerEmail: string | null;
  itemCount: number;
  totalCents: number;
  /**
   * Cents still refundable = captured − already-refunded (from the transaction ledger). Equals
   * totalCents for a fully-paid, un-refunded order; less on a partially-refunded one. The refund
   * modal drives its "Full refund" figure and partial cap off THIS, not the gross totalCents, so it
   * can't advertise more than is actually refundable (which the server would then 422).
   */
  remainingRefundableCents: number;
  currency: string;
  attribution: string | null;
  state: string;
  financialStatus: string;
  createdAt: string;
}

export interface DraftCartRow {
  id: string;
  ref: string;
  buyerEmail: string | null;
  itemCount: number;
  valueCents: number;
  currency: string;
  createdAt: string;
}

export interface AbandonedCheckoutRow {
  id: string;
  ref: string;
  buyerEmail: string | null;
  totalCents: number;
  currency: string;
  createdAt: string;
}

export interface ShipChargeRow {
  orderRef: string;
  carrier: string | null;
  tracking: string | null;
  costCents: number;
  matched: boolean;
  createdAt: string;
}

export interface OrdersPage {
  orders: OrderRow[];
  drafts: DraftCartRow[];
  abandoned: AbandonedCheckoutRow[];
  shipCharges: ShipChargeRow[];
}
