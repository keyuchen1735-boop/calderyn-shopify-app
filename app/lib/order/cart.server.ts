// Cart build + line snapshot + pricing (platform pivot #2a). Server-only: reaches
// Postgres through the service-role client (getSupabase, BYPASSRLS), threading shop_id
// explicitly on every read/write exactly like buyer/identity.server.ts — the migration's
// current_shop_id() RLS policies guard the PostgREST path; this is the application path.
//
// Unit price, currency, and title are SNAPSHOTTED from getCatalog() at add-to-cart time:
// what the buyer saw is what is persisted on cart_line, so a later catalog price OR currency
// change never silently re-prices or re-denominates an existing cart. Subtotal + currency are
// computed in priceCart purely from those snapshots (no live catalog read). Cents are integers.

import { getSupabase } from "~/lib/supabase.server";
import { getCatalog } from "~/lib/storefront/catalog.server";
import { DEMO_SHOP_ID } from "~/lib/storefront/shop.server";
import type { StoreProduct, StoreVariant } from "~/lib/storefront/catalog";
import type { QuoteLine, PricedLine } from "~/lib/commerce/types";

/**
 * Thrown by addCartLine when a variant can't be added because it no longer resolves in the catalog
 * or is unavailable (sold out / archived) — the common race of a buyer clicking Add after stock ran
 * out while the PDP was open. The add-to-cart route catches it and redirects back to the PDP with a
 * friendly "sold out" notice instead of surfacing a raw 500. Extends Error so existing catch-alls
 * still handle it.
 */
export class VariantUnavailableError extends Error {
  readonly variantId: string;
  constructor(variantId: string, reason: "not_found" | "unavailable") {
    super(`variant ${variantId} ${reason === "not_found" ? "not found" : "is not available"}`);
    this.name = "VariantUnavailableError";
    this.variantId = variantId;
  }
}

/** The demo shell has no shop row; its sentinel id can never key the uuid cart
 *  tables. Fail with a named error here (defense in depth) so any cart entry
 *  point that forgets its route-level browse-only guard surfaces a clear
 *  message instead of a Postgres uuid-cast 500. */
function assertPersistableShop(shopId: string): void {
  if (shopId === DEMO_SHOP_ID) {
    throw new Error("demo shell is browse-only: carts cannot be persisted for the demo tenant");
  }
}

export interface Cart {
  id: string;
  shopId: string;
  buyerId: string | null;
  state: string;
  createdAt: string;
}

export interface CartLine {
  id: string;
  cartId: string;
  variantId: string;
  quantity: number;
  unitPriceCents: number;
  currency: string;
  titleSnapshot: string;
}

const LINE_COLS = "id, cart_id, variant_id, quantity, unit_price_cents, currency, title_snapshot";

export interface PricedCart {
  cartId: string;
  lines: CartLine[];
  subtotalCents: number;
  currency: string;
}

/** Compose the snapshotted line title from the catalog product + variant. */
function snapshotTitle(product: StoreProduct, variant: StoreVariant): string {
  const v = variant.title?.trim();
  return v && v.toLowerCase() !== product.title.toLowerCase()
    ? `${product.title} - ${v}`
    : product.title;
}

/**
 * Resolve a variant id against the shop's catalog. Returns the owning product + variant,
 * or null if no product carries a variant with that id. Scans listProducts(shopId) because
 * the catalog contract is keyed by product handle, not variant id.
 */
async function resolveVariant(
  shopId: string,
  variantId: string,
): Promise<{ product: StoreProduct; variant: StoreVariant } | null> {
  const products = await getCatalog().listProducts(shopId);
  for (const product of products) {
    for (const variant of product.variants) {
      if (variant.id === variantId) return { product, variant };
    }
  }
  return null;
}

/** Create an empty cart (state='cart', no buyer yet). */
export async function buildCart(shopId: string): Promise<Cart> {
  if (!shopId) throw new Error("shopId is required");
  assertPersistableShop(shopId);
  const { data, error } = await getSupabase()
    .from("cart")
    .insert({ shop_id: shopId, state: "cart" })
    .select("id, shop_id, buyer_id, state, created_at")
    .single();
  if (error) throw error;
  if (!data) throw new Error("cart insert returned no row");
  return mapCart(data as Record<string, unknown>);
}

/**
 * Add a line to a cart, snapshotting unit price + currency + title from the catalog. One line
 * per variant (unique(shop_id, cart_id, variant_id)): a repeat add INCREMENTS the existing
 * line's quantity rather than creating a duplicate row, preserving that line's ORIGINAL price/
 * currency snapshot. Fails visibly (rule 12) when the variant does not exist or is unavailable
 * — never silently drops or persists an unbuyable line. quantity must be a positive integer.
 *
 * ponytail: the read-existing-then-update path is two non-tx PostgREST calls (mirrors the
 * non-atomic multi-write in buyer/identity.server.ts); the unique index is the hard guard
 * against duplicate variant rows under a concurrent double-add. Atomic increment is the
 * upgrade: a security-definer RPC doing `insert ... on conflict do update set quantity = ...`.
 */
// Hard ceiling on a single cart line so a scripted client cannot inflate a cart
// (and the downstream checkout total) without bound.
const MAX_LINE_QUANTITY = 999;

export async function addCartLine(
  shopId: string,
  cartId: string,
  variantId: string,
  quantity: number,
): Promise<CartLine & { productId: string }> {
  if (!shopId) throw new Error("shopId is required");
  assertPersistableShop(shopId);
  if (!cartId) throw new Error("cartId is required");
  if (!variantId) throw new Error("variantId is required");
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error(`quantity must be a positive integer, got ${quantity}`);
  }
  if (quantity > MAX_LINE_QUANTITY) {
    throw new Error(`quantity ${quantity} exceeds the per-line maximum ${MAX_LINE_QUANTITY}`);
  }

  const resolved = await resolveVariant(shopId, variantId);
  if (!resolved) {
    throw new VariantUnavailableError(variantId, "not_found");
  }
  if (!resolved.variant.available) {
    throw new VariantUnavailableError(variantId, "unavailable");
  }

  const sb = getSupabase();
  const existing = await sb
    .from("cart_line")
    .select(LINE_COLS)
    .eq("shop_id", shopId)
    .eq("cart_id", cartId)
    .eq("variant_id", variantId)
    .maybeSingle();
  if (existing.error) throw existing.error;

  if (existing.data) {
    const line = mapLine(existing.data as Record<string, unknown>);
    const bumped = await sb
      .from("cart_line")
      .update({ quantity: Math.min(line.quantity + quantity, MAX_LINE_QUANTITY) }) // keep original price/currency snapshot
      .eq("shop_id", shopId)
      .eq("id", line.id)
      .select(LINE_COLS)
      .single();
    if (bumped.error) throw bumped.error;
    if (!bumped.data) throw new Error("cart_line update returned no row");
    return { ...mapLine(bumped.data as Record<string, unknown>), productId: resolved.product.id };
  }

  const { data, error } = await sb
    .from("cart_line")
    .insert({
      shop_id: shopId,
      cart_id: cartId,
      variant_id: variantId,
      quantity,
      unit_price_cents: resolved.variant.priceCents, // SNAPSHOT
      currency: resolved.variant.currency.toLowerCase(), // SNAPSHOT
      title_snapshot: snapshotTitle(resolved.product, resolved.variant), // SNAPSHOT
    })
    .select(LINE_COLS)
    .single();
  if (error) throw error;
  if (!data) throw new Error("cart_line insert returned no row");
  return { ...mapLine(data as Record<string, unknown>), productId: resolved.product.id };
}

/**
 * Price a cart purely from the cart_line SNAPSHOTS — no live catalog read. Subtotal sums
 * unit_price_cents * quantity in integer cents; currency is the single snapshotted currency
 * across the lines. Because both come from the add-time snapshot, a later catalog price or
 * currency change cannot re-price or re-denominate an existing cart. A cart whose lines mix
 * currencies fails visibly (rule 12). An empty cart prices to 0 / 'usd'.
 */
export async function priceCart(shopId: string, cartId: string): Promise<PricedCart> {
  if (!shopId) throw new Error("shopId is required");
  assertPersistableShop(shopId);
  if (!cartId) throw new Error("cartId is required");

  const { data, error } = await getSupabase()
    .from("cart_line")
    .select(LINE_COLS)
    .eq("shop_id", shopId)
    .eq("cart_id", cartId);
  if (error) throw error;

  const lines = ((data ?? []) as Record<string, unknown>[]).map(mapLine);
  const subtotalCents = lines.reduce((sum, l) => sum + l.unitPriceCents * l.quantity, 0);
  const currencies = new Set(lines.map((l) => l.currency));
  if (currencies.size > 1) {
    throw new Error(`cart ${cartId} mixes currencies: ${[...currencies].sort().join(", ")}`);
  }
  const currency = currencies.values().next().value ?? "usd";
  return { cartId, lines, subtotalCents, currency };
}

/**
 * Price a list of (variant, quantity) against the live catalog — the single pricing path
 * shared by cart add, checkout, and agentic quotes. Throws (rule 12) on an unknown or
 * unavailable variant rather than silently dropping it. Mixed currencies fail visibly.
 */
export async function priceLines(
  shopId: string,
  lines: QuoteLine[],
): Promise<{ lines: PricedLine[]; subtotalCents: number; currency: string }> {
  if (!shopId) throw new Error("shopId is required");
  const priced: PricedLine[] = [];
  for (const line of lines) {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new Error(`quantity must be a positive integer, got ${line.quantity}`);
    }
    const resolved = await resolveVariant(shopId, line.variantId);
    if (!resolved) throw new Error(`variant ${line.variantId} not found in catalog for shop ${shopId}`);
    if (!resolved.variant.available) throw new Error(`variant ${line.variantId} is not available`);
    priced.push({
      variantId: line.variantId,
      quantity: line.quantity,
      unitPriceCents: resolved.variant.priceCents,
      currency: resolved.variant.currency.toLowerCase(),
      titleSnapshot: snapshotTitle(resolved.product, resolved.variant),
    });
  }
  const currencies = new Set(priced.map((l) => l.currency));
  if (currencies.size > 1) {
    throw new Error(`lines mix currencies: ${[...currencies].sort().join(", ")}`);
  }
  const subtotalCents = priced.reduce((s, l) => s + l.unitPriceCents * l.quantity, 0);
  const currency = currencies.values().next().value ?? "usd";
  return { lines: priced, subtotalCents, currency };
}

/**
 * Remove a single line from a cart (buyer cart editing, #2c-1). Shop + cart scoped so a crafted
 * request can only touch the buyer's own cart; a line id not in this cart is an idempotent no-op.
 * This is the recovery path for a cart holding a now-unavailable variant: without it a sold-out /
 * archived line dead-ends checkout in a permanent 502 with no way to drop the offending item.
 */
export async function removeCartLine(shopId: string, cartId: string, lineId: string): Promise<void> {
  if (!shopId) throw new Error("shopId is required");
  assertPersistableShop(shopId);
  if (!cartId) throw new Error("cartId is required");
  if (!lineId) throw new Error("lineId is required");
  const { error } = await getSupabase()
    .from("cart_line")
    .delete()
    .eq("shop_id", shopId)
    .eq("cart_id", cartId)
    .eq("id", lineId);
  if (error) throw error;
}

/**
 * The lifecycle state of a cart ('cart' | 'checkout_pending'), or null if the cart doesn't exist
 * for this shop. Used by the confirmation page to tell a CONSUMED cart (checkout_pending — the one
 * that was just purchased) from a fresh ACTIVE basket ('cart'), so it only clears the former's
 * cookie and never wipes an in-progress cart the buyer is building.
 */
export async function getCartState(shopId: string, cartId: string): Promise<string | null> {
  if (!shopId || !cartId) return null;
  assertPersistableShop(shopId);
  const { data, error } = await getSupabase()
    .from("cart")
    .select("state")
    .eq("shop_id", shopId)
    .eq("id", cartId)
    .maybeSingle();
  if (error) throw error;
  return data ? String((data as Record<string, unknown>).state) : null;
}

/**
 * The cart's `origin` stamp (e.g. 'merchant_draft', 'recovery:<orderId>'), or null when the cart
 * doesn't exist for this shop or carries no origin. Read by the checkout route (Task 4) to detect
 * a recovery-resumed cart and thread `recovered_from` into the order's attribution snapshot.
 */
export async function getCartOrigin(shopId: string, cartId: string): Promise<string | null> {
  if (!shopId || !cartId) return null;
  assertPersistableShop(shopId);
  const { data, error } = await getSupabase()
    .from("cart")
    .select("origin")
    .eq("shop_id", shopId)
    .eq("id", cartId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const origin = (data as Record<string, unknown>).origin;
  return origin == null ? null : String(origin);
}

/** Empty a cart: delete every line. Shop + cart scoped; an already-empty cart is a harmless no-op. */
export async function clearCart(shopId: string, cartId: string): Promise<void> {
  if (!shopId) throw new Error("shopId is required");
  assertPersistableShop(shopId);
  if (!cartId) throw new Error("cartId is required");
  const { error } = await getSupabase()
    .from("cart_line")
    .delete()
    .eq("shop_id", shopId)
    .eq("cart_id", cartId);
  if (error) throw error;
}

function mapCart(row: Record<string, unknown>): Cart {
  return {
    id: String(row.id),
    shopId: String(row.shop_id),
    buyerId: row.buyer_id == null ? null : String(row.buyer_id),
    state: String(row.state),
    createdAt: String(row.created_at),
  };
}

function mapLine(row: Record<string, unknown>): CartLine {
  return {
    id: String(row.id),
    cartId: String(row.cart_id),
    variantId: String(row.variant_id),
    quantity: Number(row.quantity),
    unitPriceCents: Number(row.unit_price_cents),
    currency: String(row.currency),
    titleSnapshot: String(row.title_snapshot),
  };
}
