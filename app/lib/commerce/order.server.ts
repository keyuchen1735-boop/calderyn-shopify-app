// placeAgenticOrder — turn a LOCKED quote into an owned `orders` row (checkout_pending) tagged
// with its agentic channel. Mirrors createCheckout's writes (buyer upsert + order + lines) but
// prices from the locked quote, never re-quoting (the "no second chance" guarantee). Payment is
// attached by the surface adapter (Stripe Checkout link for MCP; SPT charge for ACP) — this
// function never charges, so a crash leaves a checkout_pending order with no payment (safe).
import { randomBytes } from "node:crypto";
import { getSupabase } from "~/lib/supabase.server";
import { upsertGuestBuyer, addBuyerAddress, recordCheckoutConsent, type BuyerAddressInput } from "~/lib/buyer/identity.server";
import { getQuote } from "./quote-store.server";

export class QuoteExpiredError extends Error {
  code = "QUOTE_EXPIRED";
  constructor(quoteId: string) { super(`quote ${quoteId} is expired or unknown; re-quote required`); }
}

export interface AgenticBuyer {
  email: string;
  phone?: string | null;
  address?: BuyerAddressInput;
  consent?: { version: string; marketingOptIn: boolean; sourceIp?: string | null; ua?: string | null };
}

export interface PlaceResult { orderId: string; confirmationToken: string; totalCents: number; currency: string; }

export async function placeAgenticOrder(
  shopId: string,
  quoteId: string,
  buyer: AgenticBuyer,
  channel: { protocol: "acp" | "mcp"; clientId: string },
): Promise<PlaceResult> {
  if (!shopId) throw new Error("shopId is required");
  if (!buyer?.email) throw new Error("buyer.email is required");

  const quote = await getQuote(shopId, quoteId);
  if (!quote) throw new QuoteExpiredError(quoteId); // expired/unknown -> fail before any write

  const buyerRow = await upsertGuestBuyer(shopId, { email: buyer.email, phone: buyer.phone });
  if (buyer.address) await addBuyerAddress(shopId, buyerRow.id, buyer.address);
  if (buyer.consent) await recordCheckoutConsent(shopId, buyerRow.id, buyer.consent);

  const confirmationToken = randomBytes(32).toString("base64url");
  const sb = getSupabase();
  const orderIns = await sb.from("orders").insert({
    shop_id: shopId,
    buyer_id: buyerRow.id,
    channel: "agentic",
    protocol: channel.protocol,
    client_id: channel.clientId,
    subtotal_cents: quote.subtotalCents,
    shipping_cents: quote.shippingCents,
    tax_cents: quote.taxCents,
    total_cents: quote.totalCents,
    currency: quote.currency,
    attribution: { channel: "agentic", protocol: channel.protocol, client_id: channel.clientId },
    confirmation_token: confirmationToken,
  }).select("id").single();
  if (orderIns.error) throw orderIns.error;
  if (!orderIns.data) throw new Error("orders insert returned no row");
  const orderId = String((orderIns.data as Record<string, unknown>).id);

  const lineRows = quote.lines.map((l) => ({
    shop_id: shopId, order_id: orderId, variant_id: l.variantId, quantity: l.quantity,
    unit_price_cents: l.unitPriceCents, title_snapshot: l.titleSnapshot,
  }));
  const lineIns = await sb.from("order_line").insert(lineRows);
  if (lineIns.error) throw lineIns.error;

  return { orderId, confirmationToken, totalCents: quote.totalCents, currency: quote.currency };
}
