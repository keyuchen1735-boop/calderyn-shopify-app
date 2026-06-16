import type { ParsedInvoiceRow } from "./csv";

export interface MatchOrder {
  id: string;
  orderNumber: string;
  trackingNos: string[];
}

export interface InvoiceLineRow {
  orderRef: string | null;
  trackingNo: string | null;
  costCents: number;
  matchedOrderId: string | null;
}

export interface MatchResult {
  matched: InvoiceLineRow[];
  unmatched: InvoiceLineRow[];
}

/** Strip a leading '#', trim, lowercase — so "#1001", " 1001 ", "1001" all match. */
export function normOrder(ref: string): string {
  return ref.replace(/^#/, "").trim().toLowerCase();
}

export function matchInvoiceLines(rows: ParsedInvoiceRow[], orders: MatchOrder[]): MatchResult {
  const byOrder = new Map<string, string>();
  const byTracking = new Map<string, string>();
  for (const o of orders) {
    byOrder.set(normOrder(o.orderNumber), o.id);
    for (const t of o.trackingNos) byTracking.set(t.trim().toLowerCase(), o.id);
  }
  const matched: InvoiceLineRow[] = [];
  const unmatched: InvoiceLineRow[] = [];
  for (const r of rows) {
    let id: string | undefined;
    if (r.orderRef) id = byOrder.get(normOrder(r.orderRef));
    if (!id && r.trackingNo) id = byTracking.get(r.trackingNo.trim().toLowerCase());
    const line: InvoiceLineRow = {
      orderRef: r.orderRef,
      trackingNo: r.trackingNo,
      costCents: r.costCents,
      matchedOrderId: id ?? null,
    };
    if (id) matched.push(line);
    else unmatched.push(line);
  }
  return { matched, unmatched };
}
