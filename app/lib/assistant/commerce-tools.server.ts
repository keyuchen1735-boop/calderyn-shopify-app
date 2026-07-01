// The agentic-commerce toolset on the existing MCP seam. These tools carry the `commerce`
// scope; makeToolDispatcher refuses them for a client without it (tools.server.ts). Money in
// cents. place_order returns a Stripe-hosted pay URL (the Claude/MCP payment path).
import type Anthropic from "@anthropic-ai/sdk";
import { getAgenticCatalog } from "~/lib/commerce/catalog.server";
import { quoteCart } from "~/lib/commerce/quote.server";
import { lockQuote, getQuote } from "~/lib/commerce/quote-store.server";
import { assertWithinCommerceCap } from "~/lib/commerce/guardrail.server";
import { placeAgenticOrder } from "~/lib/commerce/order.server";
import { createCommerceCheckoutSession } from "~/lib/commerce/stripe-checkout.server";
import { sha256hex } from "~/lib/mcp_oauth.server";

export const COMMERCE_TOOL_NAMES = ["get_catalog", "create_quote", "get_quote", "place_order"] as const;

export const COMMERCE_TOOLS: Anthropic.Tool[] = [
  { name: "get_catalog", description: "List buyable products (variant id, title, price in cents, available qty). Use before quoting.", input_schema: { type: "object", properties: {} } },
  { name: "create_quote", description: "Lock an ACCURATE quote (price + real shipping + tax) for line items shipping to a destination. Returns quote_id + totals in cents + expiry. ALWAYS quote before placing an order; never estimate.", input_schema: { type: "object", properties: {
    line_items: { type: "array", items: { type: "object", properties: { variant_id: { type: "string" }, quantity: { type: "number" } }, required: ["variant_id", "quantity"] } },
    destination: { type: "object", properties: { street1: { type: "string" }, street2: { type: "string" }, city: { type: "string" }, state: { type: "string" }, zip: { type: "string" }, country: { type: "string" } }, required: ["street1", "city", "state", "zip", "country"] },
  }, required: ["line_items", "destination"] } },
  { name: "get_quote", description: "Re-read a locked quote by id. Returns the SAME totals (never re-prices), or an expired error.", input_schema: { type: "object", properties: { quote_id: { type: "string" } }, required: ["quote_id"] } },
  { name: "place_order", description: "Place a real order for a locked quote and return a payment URL the buyer opens to pay. Requires the buyer's email. The order is unpaid until the buyer completes payment at the URL.", input_schema: { type: "object", properties: { quote_id: { type: "string" }, email: { type: "string" }, phone: { type: "string" } }, required: ["quote_id", "email"] } },
];

export interface CommerceCtx { shopId: string; clientId: string; }
export interface CommerceResult { content: string; isError?: boolean; }
const ok = (o: unknown): CommerceResult => ({ content: JSON.stringify(o) });

export async function handleCommerceTool(name: string, input: Record<string, unknown>, ctx: CommerceCtx): Promise<CommerceResult> {
  switch (name) {
    case "get_catalog":
      return ok({ products: await getAgenticCatalog(ctx.shopId) });
    case "create_quote": {
      const lines = (input.line_items as Array<{ variant_id: string; quantity: number }>).map((l) => ({ variantId: l.variant_id, quantity: l.quantity }));
      const dest = input.destination as { street1: string; street2?: string; city: string; state: string; zip: string; country: string };
      const quote = await quoteCart(ctx.shopId, lines, dest);
      const locked = await lockQuote(ctx.shopId, quote, { clientId: ctx.clientId, destinationHash: sha256hex(JSON.stringify(dest)) });
      return ok({ quote_id: locked.quoteId, expires_at: locked.expiresAt, subtotal_cents: quote.subtotalCents, shipping_cents: quote.shippingCents, tax_cents: quote.taxCents, total_cents: quote.totalCents, currency: quote.currency, delivery_by: quote.deliveryLatest, estimate: quote.fallbackUsed || quote.lowConfidence });
    }
    case "get_quote": {
      const q = await getQuote(ctx.shopId, String(input.quote_id));
      if (!q) return { content: JSON.stringify({ code: "QUOTE_EXPIRED", message: "quote expired; create a new quote" }), isError: true };
      return ok({ quote_id: q.quoteId, total_cents: q.totalCents, currency: q.currency, expires_at: q.expiresAt });
    }
    case "place_order": {
      const q = await getQuote(ctx.shopId, String(input.quote_id));
      if (!q) return { content: JSON.stringify({ code: "QUOTE_EXPIRED", message: "quote expired; create a new quote" }), isError: true };
      await assertWithinCommerceCap(ctx.clientId, q.totalCents); // rule 5: BEFORE placing
      const placed = await placeAgenticOrder(ctx.shopId, q.quoteId, { email: String(input.email), phone: input.phone ? String(input.phone) : null }, { protocol: "mcp", clientId: ctx.clientId });
      const session = await createCommerceCheckoutSession(ctx.shopId, { orderId: placed.orderId, totalCents: placed.totalCents, currency: placed.currency, confirmationToken: placed.confirmationToken });
      return ok({ order_id: placed.orderId, pay_url: session.url, total_cents: placed.totalCents, currency: placed.currency, status: "awaiting_payment" });
    }
    default:
      return { content: JSON.stringify({ code: "UNKNOWN_TOOL", message: `Unknown commerce tool: ${name}` }), isError: true };
  }
}
