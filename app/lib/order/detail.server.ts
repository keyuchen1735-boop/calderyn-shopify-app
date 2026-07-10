// Unified order-detail read model (Task 9): one assembly that serves both the native
// checkout spine (`orders` / `order_line` / ...) and the imported (Shopify-paid, read-only)
// history (`imported_order` / ...), shaped into the single OrderDetail contract so the
// detail route/screen (Tasks 10-12) never branches on source. Service-role reads threaded
// by shop_id throughout — same access pattern as list.server.ts / imported-list.server.ts.
//
// sourceId prefix routing: "shopify:<uuid>" -> imported (read-only) branch; a bare uuid or
// "calderyn:<uuid>" -> native branch. Returns null on no row in EITHER branch — the caller
// (the detail route) 404s rather than this module throwing on a not-found id.
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "~/lib/supabase.server";
import { formatOrderRef } from "./checkout.server";
import { remainingRefundableByOrder } from "./list.server";
import { formatMoney } from "~/lib/storefront/money";
import type { OrderDetail, OrderDetailFulfillment, OrderDetailLine, OrderTimelineEvent } from "./detail-types";

const SHOPIFY_PREFIX = "shopify:";
const CALDERYN_PREFIX = "calderyn:";

/** True for an imported (Shopify-paid, read-only) order id. Shared by the write routes
 *  (Task 10: fulfill/cancel/notes/tags/archive) so every merchant-mutation surface refuses
 *  a `shopify:`-prefixed id the same way, with the same prefix this module already owns. */
export function isImportedOrderId(sourceId: string): boolean {
  return sourceId.startsWith(SHOPIFY_PREFIX);
}

/**
 * Strips an optional `calderyn:` prefix, mirroring loadOrderDetail's native branch (line ~77)
 * so a native order id round-trips the same way through the write routes as it does through
 * this read model — a caller that sends the `calderyn:<uuid>` form this module already accepts
 * for reads must not 404 on a write route just because that route used the raw id verbatim.
 * A bare uuid (no prefix) passes through unchanged.
 */
export function stripNativeOrderPrefix(sourceId: string): string {
  return sourceId.startsWith(CALDERYN_PREFIX) ? sourceId.slice(CALDERYN_PREFIX.length) : sourceId;
}

/** Shop-scoped existence check for a native order — shared by the write routes (Task 10:
 *  notes/tags) that must 404 before touching a related table (order_note/order_tag) rather than
 *  let a foreign-key violation surface as an opaque 500. */
export async function nativeOrderExists(
  shopId: string,
  orderId: string,
  sb: SupabaseClient = getSupabase(),
): Promise<boolean> {
  const { data, error } = await sb.from("orders").select("id").eq("shop_id", shopId).eq("id", orderId).maybeSingle();
  if (error) throw new Error(`orders read failed: ${error.message}`);
  return Boolean(data);
}

/** Plain-language labels for order_state_transition.to_state (mirrors state.ts's ORDER_STATES). */
const STATE_LABELS: Record<string, string> = {
  cart: "Cart",
  checkout_pending: "Checkout started",
  paid: "Paid",
  partially_fulfilled: "Partially fulfilled",
  fulfilled: "Fulfilled",
  cancelled: "Cancelled",
  refunded: "Refunded",
  partially_refunded: "Partially refunded",
};

function humanizeState(state: string): string {
  return STATE_LABELS[state] ?? state;
}

/** Human label for the attribution jsonb captured at checkout — same extraction shape as
 *  list.server.ts's private attributionLabel (duplicated rather than exported: it's a
 *  4-line pure function and the two read models are otherwise independent). */
function attributionLabel(attribution: unknown): string | null {
  if (!attribution || typeof attribution !== "object") return null;
  const a = attribution as Record<string, unknown>;
  const v = a.campaign_name ?? a.channel ?? a.source ?? a.medium ?? null;
  return typeof v === "string" && v.trim() ? v : null;
}

/** "#1042" when order_number is present, else a short "#<tail>" of the GID — same
 *  convention as imported-list.server.ts's private orderRef (duplicated for the same
 *  reason as attributionLabel above). */
function importedOrderRef(orderNumber: string | null, externalId: string): string {
  const n = orderNumber?.trim();
  if (n) return n.startsWith("#") ? n : `#${n}`;
  const tail = externalId.split("/").pop() || externalId;
  return `#${tail}`;
}

function sortTimelineDesc(events: OrderTimelineEvent[]): OrderTimelineEvent[] {
  // Descending by .at timestamp; ties (same second) are stable-sorted by concat order (transitions, notes, refunds, fulfillments).
  return [...events].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

export async function loadOrderDetail(shopId: string, sourceId: string): Promise<OrderDetail | null> {
  if (!shopId) throw new Error("shopId is required");
  if (!sourceId) return null;

  if (sourceId.startsWith(SHOPIFY_PREFIX)) {
    const importedId = sourceId.slice(SHOPIFY_PREFIX.length);
    if (!importedId) return null;
    return loadImportedOrderDetail(shopId, importedId);
  }
  const orderId = sourceId.startsWith(CALDERYN_PREFIX) ? sourceId.slice(CALDERYN_PREFIX.length) : sourceId;
  if (!orderId) return null;
  return loadNativeOrderDetail(shopId, orderId);
}

// ---------------------------------------------------------------------------
// Native branch
// ---------------------------------------------------------------------------

const NATIVE_ORDER_COLS =
  "id, buyer_id, state, financial_status, subtotal_cents, shipping_cents, tax_cents, total_cents, currency, attribution, channel, archived_at, cancelled_at, cancel_reason, created_at";

async function loadNativeOrderDetail(shopId: string, orderId: string): Promise<OrderDetail | null> {
  const sb = getSupabase();
  const orderRes = await sb.from("orders").select(NATIVE_ORDER_COLS).eq("shop_id", shopId).eq("id", orderId).maybeSingle();
  if (orderRes.error) throw new Error(`orders read failed: ${orderRes.error.message}`);
  const o = orderRes.data as Record<string, unknown> | null;
  if (!o) return null;

  const buyerId = o.buyer_id == null ? null : String(o.buyer_id);
  const currency = String(o.currency ?? "usd");
  const totalCents = Number(o.total_cents ?? 0);

  // Independent reads — none depends on another's result — run together.
  const [
    lines,
    { fulfillments, fulfilledByLine },
    buyer,
    shippingAddress,
    tags,
    notes,
    transitions,
    refunds,
    ledgerMap,
  ] = await Promise.all([
    loadNativeLines(sb, shopId, orderId),
    loadFulfillments(sb, shopId, orderId),
    buyerId ? loadBuyer(sb, shopId, buyerId) : Promise.resolve(null),
    buyerId ? loadDefaultShippingAddress(sb, shopId, buyerId) : Promise.resolve(null),
    loadTags(sb, shopId, orderId),
    loadNotes(sb, shopId, orderId),
    loadTransitions(sb, shopId, orderId),
    loadRefundAudits(sb, shopId, orderId, currency),
    remainingRefundableByOrder(shopId, [orderId]),
  ]);

  const linesWithFulfillment: OrderDetailLine[] = lines.map((l) => ({
    ...l,
    fulfilledQuantity: fulfilledByLine.get(l.id) ?? 0,
  }));

  // Ledger truth: remaining = captured − already-refunded (floored at 0 by the shared
  // helper); a native order's capture is its total_cents, so refunded = total − remaining.
  const remainingRefundableCents = ledgerMap.get(orderId) ?? totalCents;
  // Refunded = total - remaining, relying on the invariant that a native order's capture equals total_cents.
  const refundedCents = Math.max(0, totalCents - remainingRefundableCents);

  const timeline = sortTimelineDesc([...transitions, ...notes, ...refunds, ...fulfillmentEvents(fulfillments)]);

  return {
    source: "calderyn",
    id: String(o.id),
    ref: formatOrderRef(String(o.id)),
    createdAt: String(o.created_at),
    state: String(o.state),
    financialStatus: String(o.financial_status ?? "pending"),
    archivedAt: o.archived_at == null ? null : String(o.archived_at),
    cancelledAt: o.cancelled_at == null ? null : String(o.cancelled_at),
    cancelReason: o.cancel_reason == null ? null : String(o.cancel_reason),
    channel: o.channel == null ? null : String(o.channel),
    attribution: attributionLabel(o.attribution),
    currency,
    subtotalCents: Number(o.subtotal_cents ?? 0),
    shippingCents: Number(o.shipping_cents ?? 0),
    taxCents: Number(o.tax_cents ?? 0),
    discountCents: 0, // no discount column on the native `orders` spine
    totalCents,
    refundedCents,
    remainingRefundableCents,
    buyer,
    shippingAddress,
    lines: linesWithFulfillment,
    fulfillments,
    tags,
    timeline,
    readOnly: false,
  };
}

async function loadNativeLines(
  sb: SupabaseClient,
  shopId: string,
  orderId: string,
): Promise<Array<Omit<OrderDetailLine, "fulfilledQuantity">>> {
  const { data, error } = await sb
    .from("order_line")
    .select("id, variant_id, quantity, unit_price_cents, title_snapshot")
    .eq("shop_id", shopId)
    .eq("order_id", orderId);
  if (error) throw new Error(`order_line read failed: ${error.message}`);
  const rows = (data ?? []) as Record<string, unknown>[];

  const variantIds = [...new Set(rows.map((r) => String(r.variant_id)))];
  const skuByVariant = new Map<string, string | null>();
  if (variantIds.length > 0) {
    const { data: variants, error: vErr } = await sb
      .from("variant_dim")
      .select("id, sku")
      .eq("shop_id", shopId)
      .in("id", variantIds);
    if (vErr) throw new Error(`variant_dim read failed: ${vErr.message}`);
    for (const v of (variants ?? []) as Record<string, unknown>[]) {
      skuByVariant.set(String(v.id), v.sku == null ? null : String(v.sku));
    }
  }

  return rows.map((r) => ({
    id: String(r.id),
    title: String(r.title_snapshot),
    sku: skuByVariant.get(String(r.variant_id)) ?? null,
    quantity: Number(r.quantity ?? 0),
    unitPriceCents: Number(r.unit_price_cents ?? 0),
  }));
}

interface FulfillmentAgg {
  fulfillments: OrderDetailFulfillment[];
  /** order_line.id -> total units fulfilled across every fulfillment on this order. */
  fulfilledByLine: Map<string, number>;
}

async function loadFulfillments(sb: SupabaseClient, shopId: string, orderId: string): Promise<FulfillmentAgg> {
  const { data, error } = await sb
    .from("fulfillment")
    .select("id, tracking_number, carrier, notified_at, created_at")
    .eq("shop_id", shopId)
    .eq("order_id", orderId);
  if (error) throw new Error(`fulfillment read failed: ${error.message}`);
  const fRows = (data ?? []) as Record<string, unknown>[];

  const fulfilledByLine = new Map<string, number>();
  const unitsByFulfillment = new Map<string, number>();
  const fIds = fRows.map((r) => String(r.id));
  if (fIds.length > 0) {
    const { data: lineRows, error: lineErr } = await sb
      .from("fulfillment_line")
      .select("fulfillment_id, order_line_id, quantity")
      .eq("shop_id", shopId)
      .in("fulfillment_id", fIds);
    if (lineErr) throw new Error(`fulfillment_line read failed: ${lineErr.message}`);
    for (const l of (lineRows ?? []) as Record<string, unknown>[]) {
      const qty = Number(l.quantity ?? 0);
      const olId = String(l.order_line_id);
      const fId = String(l.fulfillment_id);
      fulfilledByLine.set(olId, (fulfilledByLine.get(olId) ?? 0) + qty);
      unitsByFulfillment.set(fId, (unitsByFulfillment.get(fId) ?? 0) + qty);
    }
  }

  const fulfillments: OrderDetailFulfillment[] = fRows.map((r) => ({
    id: String(r.id),
    createdAt: String(r.created_at),
    trackingNumber: r.tracking_number == null ? null : String(r.tracking_number),
    carrier: r.carrier == null ? null : String(r.carrier),
    notifiedAt: r.notified_at == null ? null : String(r.notified_at),
    units: unitsByFulfillment.get(String(r.id)) ?? 0,
  }));

  return { fulfillments, fulfilledByLine };
}

async function loadBuyer(sb: SupabaseClient, shopId: string, buyerId: string): Promise<OrderDetail["buyer"]> {
  const { data, error } = await sb
    .from("buyer_dim")
    .select("id, email_normalized")
    .eq("shop_id", shopId)
    .eq("id", buyerId)
    .maybeSingle();
  if (error) throw new Error(`buyer_dim read failed: ${error.message}`);
  if (!data) return null;
  const row = data as Record<string, unknown>;
  return { id: String(row.id), email: String(row.email_normalized ?? "") };
}

async function loadDefaultShippingAddress(
  sb: SupabaseClient,
  shopId: string,
  buyerId: string,
): Promise<OrderDetail["shippingAddress"]> {
  const { data, error } = await sb
    .from("buyer_address")
    .select("name, line1, line2, city, region, postal, country")
    .eq("shop_id", shopId)
    .eq("buyer_id", buyerId)
    .eq("kind", "shipping")
    .order("is_default", { ascending: false })
    .limit(1);
  if (error) throw new Error(`buyer_address read failed: ${error.message}`);
  const row = ((data ?? []) as Record<string, unknown>[])[0];
  if (!row) return null;
  return {
    name: row.name == null ? null : String(row.name),
    line1: String(row.line1 ?? ""),
    line2: row.line2 == null ? null : String(row.line2),
    city: row.city == null ? null : String(row.city),
    region: row.region == null ? null : String(row.region),
    postal: row.postal == null ? null : String(row.postal),
    country: String(row.country ?? ""),
  };
}

async function loadTags(sb: SupabaseClient, shopId: string, orderId: string): Promise<string[]> {
  const { data, error } = await sb.from("order_tag").select("tag").eq("shop_id", shopId).eq("order_id", orderId);
  if (error) throw new Error(`order_tag read failed: ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).map((r) => String(r.tag));
}

async function loadNotes(sb: SupabaseClient, shopId: string, orderId: string): Promise<OrderTimelineEvent[]> {
  const { data, error } = await sb
    .from("order_note")
    .select("author_email, body, created_at")
    .eq("shop_id", shopId)
    .eq("order_id", orderId);
  if (error) throw new Error(`order_note read failed: ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    kind: "note" as const,
    at: String(r.created_at),
    title: "Note",
    detail: r.body == null ? null : String(r.body),
    author: r.author_email == null ? null : String(r.author_email),
  }));
}

async function loadTransitions(sb: SupabaseClient, shopId: string, orderId: string): Promise<OrderTimelineEvent[]> {
  const { data, error } = await sb
    .from("order_state_transition")
    .select("to_state, reason, occurred_at")
    .eq("shop_id", shopId)
    .eq("order_id", orderId);
  if (error) throw new Error(`order_state_transition read failed: ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    kind: "transition" as const,
    at: String(r.occurred_at),
    title: humanizeState(String(r.to_state)),
    detail: r.reason == null ? null : String(r.reason),
    author: null,
  }));
}

/**
 * Refund audits for this order: action_audit rows with action_kind='issue_refund',
 * outcome='succeeded', filtered on the jsonb params the executor actually writes
 * (app/lib/actions/refund.server.ts persists `order_id` — snake_case — NOT `orderId`;
 * see the ground-truth note in the task report).
 */
async function loadRefundAudits(
  sb: SupabaseClient,
  shopId: string,
  orderId: string,
  currency: string,
): Promise<OrderTimelineEvent[]> {
  const { data, error } = await sb
    .from("action_audit")
    .select("created_at, params")
    .eq("shop_id", shopId)
    .eq("action_kind", "issue_refund")
    .eq("outcome", "succeeded")
    .eq("params->>order_id", orderId);
  if (error) throw new Error(`action_audit read failed: ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).map((r) => {
    const params = (r.params ?? {}) as Record<string, unknown>;
    const amountCents = Number(params.amount_cents ?? 0);
    return {
      kind: "refund" as const,
      at: String(r.created_at),
      title: "Refund issued",
      detail: formatMoney(amountCents, currency),
      author: null,
    };
  });
}

function fulfillmentEvents(fulfillments: OrderDetailFulfillment[]): OrderTimelineEvent[] {
  return fulfillments.map((f) => ({
    kind: "fulfillment" as const,
    at: f.createdAt,
    title: `Items fulfilled${f.trackingNumber ? ` · ${f.trackingNumber}` : ""}`,
    detail: f.notifiedAt ? "Customer notified" : null,
    author: null,
  }));
}

// ---------------------------------------------------------------------------
// Imported (Shopify-paid, read-only) branch
// ---------------------------------------------------------------------------

const IMPORTED_ORDER_COLS =
  "id, order_number, external_id, financial_status, currency, total_cents, subtotal_cents, shipping_cents, tax_cents, discount_cents, processed_at, buyer_id";

async function loadImportedOrderDetail(shopId: string, importedId: string): Promise<OrderDetail | null> {
  const sb = getSupabase();
  const orderRes = await sb
    .from("imported_order")
    .select(IMPORTED_ORDER_COLS)
    .eq("shop_id", shopId)
    .eq("id", importedId)
    .maybeSingle();
  if (orderRes.error) throw new Error(`imported_order read failed: ${orderRes.error.message}`);
  const o = orderRes.data as Record<string, unknown> | null;
  if (!o) return null;

  const buyerId = o.buyer_id == null ? null : String(o.buyer_id);
  const currency = String(o.currency ?? "USD").toUpperCase();
  const orderProcessedAt = o.processed_at == null ? null : String(o.processed_at);

  const [lines, refundRows, buyer] = await Promise.all([
    loadImportedLines(sb, shopId, importedId),
    loadImportedRefunds(sb, shopId, importedId),
    buyerId ? loadBuyer(sb, shopId, buyerId) : Promise.resolve(null),
  ]);

  const refundedCents = refundRows.reduce((sum, r) => sum + r.subtotalCents, 0);
  const timeline = sortTimelineDesc(
    refundRows.map((r) => ({
      kind: "refund" as const,
      at: r.processedAt ?? orderProcessedAt ?? "",
      title: "Refund issued",
      detail: formatMoney(r.subtotalCents, currency),
      author: null,
    })),
  );

  return {
    source: "shopify",
    id: String(o.id),
    ref: importedOrderRef(o.order_number == null ? null : String(o.order_number), String(o.external_id ?? "")),
    createdAt: orderProcessedAt ?? "",
    state: String(o.financial_status ?? "").toLowerCase(),
    financialStatus: String(o.financial_status ?? "").toLowerCase(),
    archivedAt: null,
    cancelledAt: null,
    cancelReason: null,
    channel: null,
    attribution: null,
    currency,
    subtotalCents: Number(o.subtotal_cents ?? 0),
    shippingCents: Number(o.shipping_cents ?? 0),
    taxCents: Number(o.tax_cents ?? 0),
    discountCents: Number(o.discount_cents ?? 0),
    totalCents: Number(o.total_cents ?? 0),
    refundedCents,
    remainingRefundableCents: 0, // no Calderyn payment_intent — never refundable through this app
    buyer,
    shippingAddress: null, // imported orders carry no buyer_address rows (no owned checkout occurred)
    lines,
    fulfillments: [],
    tags: [],
    timeline,
    readOnly: true,
  };
}

async function loadImportedLines(
  sb: SupabaseClient,
  shopId: string,
  importedOrderId: string,
): Promise<OrderDetailLine[]> {
  const { data, error } = await sb
    .from("imported_order_line")
    .select("id, quantity, price_cents, sku_dim(sku, title)")
    .eq("shop_id", shopId)
    .eq("imported_order_id", importedOrderId);
  if (error) throw new Error(`imported_order_line read failed: ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).map((r) => {
    const rel = r.sku_dim as
      | { sku: string | null; title: string | null }
      | { sku: string | null; title: string | null }[]
      | null;
    const skuRow = Array.isArray(rel) ? (rel[0] ?? null) : rel;
    return {
      id: String(r.id),
      title: skuRow?.title ?? "Unknown item",
      sku: skuRow?.sku ?? null,
      quantity: Number(r.quantity ?? 0),
      unitPriceCents: Number(r.price_cents ?? 0),
      // No fulfillment tracking is promoted for imported orders (fulfillments stay []),
      // so there is no source of truth for per-line fulfilled units — report 0 rather
      // than assume fully-shipped (rule 12: never fabricate an untracked fact).
      fulfilledQuantity: 0,
    };
  });
}

interface ImportedRefundRow {
  subtotalCents: number;
  processedAt: string | null;
}

async function loadImportedRefunds(
  sb: SupabaseClient,
  shopId: string,
  importedOrderId: string,
): Promise<ImportedRefundRow[]> {
  const { data, error } = await sb
    .from("imported_refund")
    .select("subtotal_cents, processed_at")
    .eq("shop_id", shopId)
    .eq("imported_order_id", importedOrderId);
  if (error) throw new Error(`imported_refund read failed: ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    subtotalCents: Number(r.subtotal_cents ?? 0),
    processedAt: r.processed_at == null ? null : String(r.processed_at),
  }));
}
