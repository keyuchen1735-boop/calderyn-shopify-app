// Pure ACP<->core translation. The ONLY place ACP wire field names live. Confirm field names /
// price formatting against the onboarded ACP spec version; the inputs (our core types) are stable.
import type { CatalogFeedItem } from "~/lib/commerce/catalog.server";
import type { LockedQuote } from "~/lib/commerce/quote-store.server";

export interface AcpFeedItem {
  id: string;
  title: string;
  price: string;
  availability: "in_stock" | "out_of_stock";
}

export interface AcpSessionBody {
  id: string;
  line_items: Array<{ id: string; quantity: number; amount: number }>;
  totals: { subtotal: number; shipping: number; tax: number; total: number; currency: string };
  fulfillment: { delivery_by: string | null };
  status: "ready_for_payment";
}

export function toAcpFeedItem(c: CatalogFeedItem): AcpFeedItem {
  return {
    id: c.variantId,
    title: c.title,
    price: `${(c.priceCents / 100).toFixed(2)} ${c.currency.toUpperCase()}`,
    availability: c.availableQty > 0 ? "in_stock" : "out_of_stock",
  };
}

export function toAcpSessionBody(sessionId: string, q: LockedQuote): AcpSessionBody {
  return {
    id: sessionId,
    line_items: q.lines.map((l) => ({ id: l.variantId, quantity: l.quantity, amount: l.unitPriceCents * l.quantity })),
    totals: { subtotal: q.subtotalCents, shipping: q.shippingCents, tax: q.taxCents, total: q.totalCents, currency: q.currency },
    fulfillment: { delivery_by: q.deliveryLatest },
    status: "ready_for_payment",
  };
}
