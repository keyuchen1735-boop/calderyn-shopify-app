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
import { paymentsReadiness } from "~/lib/payments/connect.server";
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
const badInput = (message: string): CommerceResult => ({
  content: JSON.stringify({ code: "INVALID_INPUT", message }),
  isError: true,
});

// Tool inputs arrive from an external AI client — validate shapes and bound
// lengths at this boundary instead of casting and letting bad data flow into
// quote/order records.
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,189}\.[^\s@]{2,63}$/;

function parseLineItems(v: unknown): Array<{ variantId: string; quantity: number }> | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > 100) return null;
  const out: Array<{ variantId: string; quantity: number }> = [];
  for (const item of v) {
    if (typeof item !== "object" || item === null) return null;
    const r = item as Record<string, unknown>;
    if (typeof r.variant_id !== "string" || !r.variant_id || r.variant_id.length > 100) return null;
    const quantity = Number(r.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) return null;
    out.push({ variantId: r.variant_id, quantity });
  }
  return out;
}

type Destination = { street1: string; street2?: string; city: string; state: string; zip: string; country: string };

function parseDestination(v: unknown): Destination | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  const field = (k: string, max: number): string | null =>
    typeof r[k] === "string" && (r[k] as string).trim() && (r[k] as string).length <= max
      ? (r[k] as string)
      : null;
  const street1 = field("street1", 200);
  const city = field("city", 100);
  const state = field("state", 60);
  const zip = field("zip", 20);
  const country = field("country", 60);
  if (!street1 || !city || !state || !zip || !country) return null;
  if (r.street2 !== undefined && (typeof r.street2 !== "string" || r.street2.length > 200)) return null;
  return { street1, street2: r.street2 as string | undefined, city, state, zip, country };
}

export async function handleCommerceTool(name: string, input: Record<string, unknown>, ctx: CommerceCtx): Promise<CommerceResult> {
  switch (name) {
    case "get_catalog":
      return ok({ products: await getAgenticCatalog(ctx.shopId) });
    case "create_quote": {
      const lines = parseLineItems(input.line_items);
      if (!lines) return badInput("line_items must be 1-100 entries of {variant_id, quantity 1-999}");
      const dest = parseDestination(input.destination);
      if (!dest) return badInput("destination must include street1, city, state, zip, country (bounded lengths)");
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
      const email = typeof input.email === "string" ? input.email.trim() : "";
      if (!EMAIL_RE.test(email) || email.length > 254) return badInput("email must be a valid address");
      if (input.phone !== undefined && input.phone !== null && (typeof input.phone !== "string" || input.phone.length > 30)) {
        return badInput("phone must be a string of at most 30 characters");
      }
      // Gate BEFORE placing: the session create fails CLOSED for a shop without a
      // fully-enabled Stripe account, so placing first would orphan a checkout_pending
      // order on every retry. Structured code so the agent can relay the real reason.
      const readiness = await paymentsReadiness(ctx.shopId);
      if (!readiness.ready) {
        return { content: JSON.stringify({ code: "PAYMENTS_NOT_READY", message: "this store is not accepting payments yet; the merchant must finish Stripe onboarding" }), isError: true };
      }
      await assertWithinCommerceCap(ctx.clientId, q.totalCents); // rule 5: BEFORE placing
      const placed = await placeAgenticOrder(ctx.shopId, q.quoteId, { email, phone: typeof input.phone === "string" && input.phone ? input.phone : null }, { protocol: "mcp", clientId: ctx.clientId });
      const session = await createCommerceCheckoutSession(ctx.shopId, { orderId: placed.orderId, totalCents: placed.totalCents, currency: placed.currency, confirmationToken: placed.confirmationToken }, readiness);
      return ok({ order_id: placed.orderId, pay_url: session.url, total_cents: placed.totalCents, currency: placed.currency, status: "awaiting_payment" });
    }
    default:
      return { content: JSON.stringify({ code: "UNKNOWN_TOOL", message: `Unknown commerce tool: ${name}` }), isError: true };
  }
}
