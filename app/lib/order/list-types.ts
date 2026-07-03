// DTO shapes shared by the owned-orders read model (list.server.ts) and the
// dashboard client/screen. Plain types only — safe to import from the browser.

export interface OrderRow {
  id: string;
  ref: string;
  buyerEmail: string | null;
  itemCount: number;
  totalCents: number;
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
  createdAt: string;
}

export interface AbandonedCheckoutRow {
  id: string;
  ref: string;
  buyerEmail: string | null;
  totalCents: number;
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
