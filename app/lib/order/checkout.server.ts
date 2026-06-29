// Checkout origination (platform pivot #2b). Server-only: turns a priced cart into a
// Calderyn-native `orders` row in `checkout_pending` plus a Stripe PaymentIntent, threading
// shop_id explicitly on every write exactly like cart.server.ts / order.server.ts (the app
// reaches Postgres only through the service-role client; the migration's current_shop_id()
// RLS guards the PostgREST path). Money is integer cents throughout.
//
// The order's lines are SNAPSHOTTED from the cart into `order_line` here so the warehouse
// emission (#2b, emit.server.ts) and fulfillment can read them back without re-pricing — the
// `orders` row carries no cart_id, so the snapshot is the only link to what was bought.
//
// TODO(parity): native-originated `orders` / `order_line` rows have no merchant-facing surface
// in the Calderyn dashboard yet — the dashboard order view still only shows Shopify-origin
// order_fact. Mirror native orders into that view when the dashboard order surface is built
// (CLAUDE.md "Dashboard parity"); the warehouse emit already feeds the analytics views for free.

import { randomBytes } from "node:crypto";
import { getSupabase } from "~/lib/supabase.server";
import { priceCart } from "./cart.server";
import {
  upsertGuestBuyer,
  addBuyerAddress,
  recordCheckoutConsent,
  type BuyerAddressInput,
} from "~/lib/buyer/identity.server";
import { createPaymentIntent } from "~/lib/payments/stripe.server";

// FLAT placeholders for the pilot — real shipping + tax calculation is a later step. The
// orders / checkout_session columns default to 0 with the same note (20260629110000_order_spine).
const PILOT_FLAT_SHIPPING_CENTS = 0;
const PILOT_FLAT_TAX_CENTS = 0;

export interface CheckoutBuyer {
  email: string;
  phone?: string | null;
  /** Optional shipping address captured at checkout (#1 buyer identity). */
  address?: BuyerAddressInput;
  /** Optional consent capture (ToS + privacy required, marketing opt-in). */
  consent?: {
    version: string;
    marketingOptIn: boolean;
    sourceIp?: string | null;
    ua?: string | null;
  };
}

export interface CheckoutResult {
  orderId: string;
  clientSecret: string;
  /**
   * Unguessable 256-bit token the buyer-facing confirmation page is keyed by (#2c-2). The
   * confirmation route looks the order up by (shop_id, confirmation_token) — NEVER by the raw
   * order id — so the confirmation URL can never be turned into an IDOR.
   */
  confirmationToken: string;
}

/** A confirmed-order summary for the buyer-facing confirmation page. PII-free by construction. */
export interface ConfirmedOrder {
  orderId: string;
  state: string;
  subtotalCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  currency: string;
  createdAt: string;
  lines: Array<{ title: string; quantity: number; unitPriceCents: number }>;
}

/**
 * Originate a checkout: price the cart, identify the buyer, persist a `checkout_pending`
 * `orders` row (+ snapshotted `order_line`s), and create the Stripe PaymentIntent keyed to
 * that order. `attribution` is a pass-through snapshot of whatever the caller captured (an
 * empty object is fine); it is persisted verbatim on the order and replayed to the warehouse
 * as ad_click_ref breadcrumbs on payment (emit.server.ts). Returns the order id + client
 * secret for the buyer-side Payment Element (#2c builds that UI).
 *
 * ponytail: the buyer upsert + order insert + line insert + PI create are separate non-tx
 * PostgREST/Stripe calls (mirrors the non-atomic multi-write in identity.server.ts). A crash
 * mid-sequence leaves a checkout_pending order with no PI (never a paid order — the order only
 * reaches `paid` when Stripe confirms capture, see stripe.server.ts), which the buyer simply
 * re-originates. Folding the order writes into one security-definer RPC is the GA upgrade.
 */
export async function createCheckout(
  shopId: string,
  cartId: string,
  buyer: CheckoutBuyer,
  attribution: Record<string, unknown> = {},
): Promise<CheckoutResult> {
  if (!shopId) throw new Error("shopId is required");
  if (!cartId) throw new Error("cartId is required");
  if (!buyer?.email) throw new Error("buyer.email is required to originate a checkout");

  const priced = await priceCart(shopId, cartId);
  const shippingCents = PILOT_FLAT_SHIPPING_CENTS;
  const taxCents = PILOT_FLAT_TAX_CENTS;
  const totalCents = priced.subtotalCents + shippingCents + taxCents;

  // Fail visibly (rule 12) BEFORE any buyer/order write. Guard the computed TOTAL, not just an
  // empty cart: a non-empty cart that totals 0 cents (e.g. all-free items — unit_price_cents=0
  // is allowed) would otherwise pass an emptiness check, write the buyer + order + lines, then
  // have createPaymentIntent reject the non-positive amount — leaving an orphan checkout_pending
  // order with no PaymentIntent. Rejecting on the total covers both the empty and $0 cases.
  if (totalCents <= 0) {
    throw new Error(`cannot originate a checkout for cart ${cartId}: nothing to charge (total ${totalCents} cents)`);
  }

  const buyerRow = await upsertGuestBuyer(shopId, { email: buyer.email, phone: buyer.phone });
  if (buyer.address) {
    await addBuyerAddress(shopId, buyerRow.id, buyer.address);
  }
  if (buyer.consent) {
    await recordCheckoutConsent(shopId, buyerRow.id, buyer.consent);
  }

  // 256-bit CSPRNG token: the unguessable key the confirmation page is fetched by (#2c-2), so
  // the confirmation URL can never be enumerated into another buyer's order/PII. base64url is
  // URL-safe (no padding/`+`/`/`), so it drops straight into the route path.
  const confirmationToken = randomBytes(32).toString("base64url");

  const sb = getSupabase();
  const orderIns = await sb
    .from("orders")
    .insert({
      shop_id: shopId,
      buyer_id: buyerRow.id,
      // state defaults to 'checkout_pending' (orders.state default); the order is BORN here.
      subtotal_cents: priced.subtotalCents,
      shipping_cents: shippingCents,
      tax_cents: taxCents,
      total_cents: totalCents,
      currency: priced.currency,
      attribution, // pass-through snapshot; replayed as ad_click_ref on payment
      confirmation_token: confirmationToken,
    })
    .select("id")
    .single();
  if (orderIns.error) throw orderIns.error;
  if (!orderIns.data) throw new Error("orders insert returned no row");
  const orderId = String((orderIns.data as Record<string, unknown>).id);

  // Snapshot the cart lines onto the order (variant_id + price + title carried verbatim from
  // the cart_line snapshot — what the buyer saw is what is recorded on the order).
  const lineRows = priced.lines.map((l) => ({
    shop_id: shopId,
    order_id: orderId,
    variant_id: l.variantId,
    quantity: l.quantity,
    unit_price_cents: l.unitPriceCents,
    title_snapshot: l.titleSnapshot,
  }));
  const lineIns = await sb.from("order_line").insert(lineRows);
  if (lineIns.error) throw lineIns.error;

  const pi = await createPaymentIntent(shopId, totalCents, priced.currency, orderId);

  return { orderId, clientSecret: pi.clientSecret, confirmationToken };
}

const ORDER_SUMMARY_COLS =
  "id, state, subtotal_cents, shipping_cents, tax_cents, total_cents, currency, created_at";

/**
 * IDOR-safe confirmation lookup (#2c-2): resolve an order by its unguessable confirmation token,
 * SCOPED to the shop. Returns null (caller 404s) when no order in this shop carries that token —
 * so an unknown OR a foreign-shop token reveals nothing. shop_id leads on every read because the
 * app reaches Postgres via the service-role key (BYPASSRLS); the token is the unguessable key and
 * the shop scope is defense-in-depth. The returned DTO is PII-FREE (no buyer email/address/IP) —
 * the confirmation page shows only what the buyer already knows: their lines + total.
 */
export async function findOrderByConfirmationToken(
  shopId: string,
  token: string,
): Promise<ConfirmedOrder | null> {
  if (!shopId) throw new Error("shopId is required");
  if (!token) return null;

  const sb = getSupabase();
  const order = await sb
    .from("orders")
    .select(ORDER_SUMMARY_COLS)
    .eq("shop_id", shopId)
    .eq("confirmation_token", token)
    .maybeSingle();
  if (order.error) throw order.error;
  if (!order.data) return null;

  const o = order.data as Record<string, unknown>;
  const orderId = String(o.id);

  const lineRes = await sb
    .from("order_line")
    .select("title_snapshot, quantity, unit_price_cents")
    .eq("shop_id", shopId)
    .eq("order_id", orderId);
  if (lineRes.error) throw lineRes.error;

  const lines = ((lineRes.data ?? []) as Record<string, unknown>[]).map((l) => ({
    title: String(l.title_snapshot),
    quantity: Number(l.quantity),
    unitPriceCents: Number(l.unit_price_cents),
  }));

  return {
    orderId,
    state: String(o.state),
    subtotalCents: Number(o.subtotal_cents),
    shippingCents: Number(o.shipping_cents),
    taxCents: Number(o.tax_cents),
    totalCents: Number(o.total_cents),
    currency: String(o.currency),
    createdAt: String(o.created_at),
    lines,
  };
}

/**
 * Display-only order reference: the leading 8 hex chars of the order UUID, upper-cased (e.g.
 * `#A1B2C3D4`). Cosmetic — the unguessable confirmation_token, not this ref, is the security
 * boundary. Shared by the confirmation page and the confirmation email so both show one ref.
 */
export function formatOrderRef(orderId: string): string {
  return `#${orderId.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}
