// app/lib/order/merchant-drafts.server.ts
// Merchant-drafted order CRUD (orders phase 3, Task 2): a "draft" is a `cart` row stamped
// `origin='merchant_draft'` (migration 20260710150000) still in state='cart' — a basket the
// MERCHANT is composing on a buyer's behalf, before it becomes a real invoice (invoice.server.ts
// turns one into an `orders` row and marks the cart consumed). Reuses cart.server.ts's
// buildCart/addCartLine/clearCart/priceCart rather than re-implementing pricing or the
// unique-per-variant line semantics.
import { getSupabase } from "~/lib/supabase.server";
import { CalderynError } from "~/lib/calderyn.server";
import { buildCart, addCartLine, clearCart, priceCart, type CartLine } from "./cart.server";

export interface MerchantDraftLineInput {
  variantId: string;
  quantity: number;
}

export interface MerchantDraftLineVM {
  id: string;
  variantId: string;
  title: string;
  quantity: number;
  unitPriceCents: number;
  currency: string;
}

export interface MerchantDraftVM {
  id: string;
  lines: MerchantDraftLineVM[];
  subtotalCents: number;
  currency: string;
  createdAt: string;
}

function toDraftLine(l: CartLine): MerchantDraftLineVM {
  return {
    id: l.id,
    variantId: l.variantId,
    title: l.titleSnapshot,
    quantity: l.quantity,
    unitPriceCents: l.unitPriceCents,
    currency: l.currency,
  };
}

/** Shop-scoped lookup: true iff `cartId` is an open (state='cart') merchant-draft cart for this shop. */
async function isMerchantDraftCart(shopId: string, cartId: string): Promise<boolean> {
  const { data, error } = await getSupabase()
    .from("cart")
    .select("id")
    .eq("shop_id", shopId)
    .eq("id", cartId)
    .eq("origin", "merchant_draft")
    .eq("state", "cart")
    .maybeSingle();
  if (error) throw error;
  return data != null;
}

function draftNotFound(cartId: string): CalderynError {
  return new CalderynError({
    code: "draft_not_found",
    status: 404,
    message: `No merchant draft cart ${cartId} found for this shop.`,
  });
}

/** Assemble the wire VM for one draft cart: its snapshotted lines + subtotal/currency + when it
 *  was created. Reuses priceCart (the single pricing path) rather than re-deriving totals. */
async function loadDraft(shopId: string, cartId: string): Promise<MerchantDraftVM> {
  const [priced, cartRes] = await Promise.all([
    priceCart(shopId, cartId),
    getSupabase().from("cart").select("created_at").eq("shop_id", shopId).eq("id", cartId).maybeSingle(),
  ]);
  if (cartRes.error) throw cartRes.error;
  if (!cartRes.data) throw draftNotFound(cartId);
  return {
    id: cartId,
    lines: priced.lines.map(toDraftLine),
    subtotalCents: priced.subtotalCents,
    currency: priced.currency,
    createdAt: String((cartRes.data as Record<string, unknown>).created_at),
  };
}

/** List every open merchant-draft cart for this shop, newest first. Small, merchant-authored
 *  set (not the full order list), so a per-cart priceCart read is simple and cheap enough. */
export async function listMerchantDrafts(shopId: string): Promise<MerchantDraftVM[]> {
  if (!shopId) throw new Error("shopId is required");
  const { data, error } = await getSupabase()
    .from("cart")
    .select("id, created_at")
    .eq("shop_id", shopId)
    .eq("origin", "merchant_draft")
    .eq("state", "cart")
    .order("created_at", { ascending: false });
  if (error) throw error;

  const drafts: MerchantDraftVM[] = [];
  for (const row of (data ?? []) as Record<string, unknown>[]) {
    drafts.push(await loadDraft(shopId, String(row.id)));
  }
  return drafts;
}

/** Create a new merchant-draft cart seeded with `lines`. Each line is added through
 *  addCartLine, so an unknown/unavailable variant fails visibly (VariantUnavailableError)
 *  rather than silently dropping — the caller (the drafts route) maps that to a 422. */
export async function createMerchantDraft(
  shopId: string,
  lines: MerchantDraftLineInput[],
): Promise<MerchantDraftVM> {
  if (!shopId) throw new Error("shopId is required");
  const cart = await buildCart(shopId);
  const upd = await getSupabase()
    .from("cart")
    .update({ origin: "merchant_draft" })
    .eq("shop_id", shopId)
    .eq("id", cart.id);
  if (upd.error) throw upd.error;

  for (const line of lines) {
    await addCartLine(shopId, cart.id, line.variantId, line.quantity);
  }
  return loadDraft(shopId, cart.id);
}

/** Replace every line on an existing merchant-draft cart: clears the current lines, then adds
 *  `lines` fresh (so each is re-snapshotted at its current catalog price). 404s (CalderynError)
 *  when `cartId` isn't an open merchant-draft cart for this shop — a merchant can never edit an
 *  already-invoiced or foreign-shop cart through this path. */
export async function replaceMerchantDraftLines(
  shopId: string,
  cartId: string,
  lines: MerchantDraftLineInput[],
): Promise<MerchantDraftVM> {
  if (!shopId) throw new Error("shopId is required");
  if (!cartId) throw new Error("cartId is required");
  if (!(await isMerchantDraftCart(shopId, cartId))) throw draftNotFound(cartId);

  await clearCart(shopId, cartId);
  for (const line of lines) {
    await addCartLine(shopId, cartId, line.variantId, line.quantity);
  }
  return loadDraft(shopId, cartId);
}

/** Delete a merchant-draft cart outright (its cart_line rows cascade via the composite FK on
 *  cart, migration 20260629110000). Shop-scoped and merchant-draft-scoped: 404s (CalderynError)
 *  on an unknown id, a foreign-shop cart, or a cart that isn't an open merchant draft (e.g. one
 *  already turned into an invoice) — this path can never delete a real order's cart. */
export async function deleteMerchantDraft(shopId: string, cartId: string): Promise<void> {
  if (!shopId) throw new Error("shopId is required");
  if (!cartId) throw new Error("cartId is required");
  if (!(await isMerchantDraftCart(shopId, cartId))) throw draftNotFound(cartId);

  const { error } = await getSupabase().from("cart").delete().eq("shop_id", shopId).eq("id", cartId);
  if (error) throw error;
}
