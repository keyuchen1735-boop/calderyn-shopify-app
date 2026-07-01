import { emitOwnedEvent } from "./emit.server";
import type { OwnedCheckoutCompleted } from "./events";

// Non-prod producer that stands in for the owned checkout's emit call, so the owned
// ingest path can be proven end-to-end (emit -> raw_owned_event -> transform -> facts)
// before the real checkout wires emitOwnedEvent. Disabled in production unless the
// OWNED_INGEST_DEV_SEED escape hatch is set (for a one-off prod smoke test).
export async function seedOwnedCheckout(params: {
  shopId: string;
  variantId: string;
  eventId: string;
  buyerId?: string | null;
}): Promise<void> {
  if (process.env.NODE_ENV === "production" && process.env.OWNED_INGEST_DEV_SEED !== "1") {
    throw new Error("seedOwnedCheckout is disabled in production");
  }
  const event: OwnedCheckoutCompleted = {
    event_id: params.eventId,
    type: "CHECKOUT_COMPLETED",
    shop_id: params.shopId,
    occurred_at: new Date().toISOString(),
    order: {
      external_id: `owned-order-${params.eventId}`,
      order_number: `#DEV-${params.eventId.slice(0, 6)}`,
      total_cents: 2500,
      subtotal_cents: 2000,
      shipping_cents: 400,
      tax_cents: 100,
      discount_cents: 0,
      currency: "USD",
      financial_status: "paid",
      buyer_id: params.buyerId ?? null,
      attribution: { utm: {}, clickIds: {}, referringSite: null },
    },
    lines: [
      {
        external_line_id: `${params.eventId}-1`,
        variant_id: params.variantId,
        quantity: 1,
        price_cents: 2000,
        total_cents: 2000,
        grams: 500,
      },
    ],
  };
  await emitOwnedEvent(event);
}
