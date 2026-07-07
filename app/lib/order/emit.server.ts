// Warehouse emission for Calderyn-native orders (platform pivot #2b). On `paid`, this replays
// the analytics fact rows the Shopify webhook ETL produces (ingest/transform.server.ts), via the
// IDENTICAL idempotent upsert contract, so the revenue/velocity warehouse keeps working whether
// an order came from Shopify or from Calderyn's own checkout. Server-only; threads shop_id
// explicitly on every read/write.
//
// Contract matched to applyOrder() in ingest/transform.server.ts:
//   - order_fact      upsert onConflict (shop_id, external_id)      — last-writer-wins
//   - order_line_fact upsert onConflict (order_id, external_line_id)
//   - ad_click_ref    upsert onConflict (order_id, platform, click_id)  (same columns/key as applyAttribution)
// external_id uses a Calderyn-native GID namespace so it can never collide with a Shopify GID,
// and source_version is a monotonic ms clock from the paid-transition time so a re-emit (or a
// later state change) wins the last-writer-wins upsert. Idempotent by construction.
//
// SCOPE BOUNDARIES (deliberate — the spec scopes emission to these fact rows; two downstream
// links are follow-ups, NOT silent bugs):
//   * attribution_fact (campaign resolution + attributed_revenue_cents) is NOT written here —
//     applyAttribution writes it on the Shopify path, but the spec scopes native emission to the
//     ad_click_ref breadcrumb only ("skip if the snapshot is empty; don't fabricate"). Until a
//     resolver runs over native ad_click_ref rows, campaign_grade's revenue attribution excludes
//     native orders. See the report's concerns.
//   * sku_id linkage (below) depends on John's owned-catalog #5 populating sku_dim with matching
//     external_ids; until then native lines emit sku_id=null (tolerated, never dropped).

import { getSupabase } from "~/lib/supabase.server";
import { clickIdPlatform } from "~/lib/attribution/parse";
import type { ClickIdKind, ClickIds, Utm } from "~/lib/attribution/types";

const CLICK_KEYS: ClickIdKind[] = ["fbclid", "gclid", "ttclid"];

/** Calderyn-native warehouse GID namespaces — distinct from `gid://shopify/...`. */
function orderGid(orderId: string): string {
  return `gid://calderyn/Order/${orderId}`;
}
function orderLineGid(orderLineId: string): string {
  return `gid://calderyn/OrderLine/${orderLineId}`;
}

/** The sub-shape of the order's free-form attribution snapshot that emit understands. */
interface AttributionSnapshot {
  clickIds?: ClickIds;
  utm?: Utm;
}

export interface EmitResult {
  externalId: string;
  sourceVersion: number;
  lineCount: number;
  clickRefCount: number;
  /** True when emission was a guarded no-op because the order is not currently `paid`. */
  skipped: boolean;
}

/**
 * Emit a paid Calderyn-native order to the analytics warehouse. Reads the OLTP order +
 * snapshotted order_line rows (the system-of-record) and upserts the derived fact rows.
 * `paidAt` is the timestamp the order's payment was confirmed (the Stripe event time) — its
 * epoch-ms is the monotonic source_version that drives the last-writer-wins upsert; using the
 * event time (constant across Stripe redeliveries of the same event) keeps re-emit idempotent.
 *
 * SELF-GUARDED: emits ONLY when the order is CURRENTLY `state='paid'`. This makes the function
 * safe to call on any `payment_intent.succeeded` delivery (including Stripe redeliveries) — a
 * first-delivery emit that failed after the order committed to `paid` self-heals on redelivery,
 * while a stale succeeded redelivery for an order that has since moved to e.g. `refunded` is a
 * no-op ({ skipped: true }) and never re-asserts paid (the refund flow owns its own emit).
 * Idempotent: re-emitting overwrites the same rows (onConflict) rather than duplicating them.
 */
export async function emitPaidOrder(
  shopId: string,
  orderId: string,
  paidAt: string,
): Promise<EmitResult> {
  if (!shopId) throw new Error("shopId is required");
  if (!orderId) throw new Error("orderId is required");

  const sb = getSupabase();

  // Reads before writes (Supabase has no client transaction): resolve the order header,
  // its lines, and the variant→sku map first so a transient read failure aborts before any
  // fact row is written (mirrors applyOrder's read-first ordering).
  const orderRead = await sb
    .from("orders")
    .select("id, state, channel, subtotal_cents, shipping_cents, tax_cents, total_cents, currency, attribution, created_at")
    .eq("shop_id", shopId)
    .eq("id", orderId)
    .maybeSingle();
  if (orderRead.error) throw orderRead.error;
  if (!orderRead.data) throw new Error(`order ${orderId} not found for shop ${shopId} on warehouse emit`);
  const order = orderRead.data as Record<string, unknown>;

  const externalId = orderGid(orderId);
  // Monotonic ms clock from the payment-confirmation time satisfies the last-writer-wins upsert.
  const sourceVersion = Date.parse(paidAt);
  if (Number.isNaN(sourceVersion)) {
    throw new Error(`invalid paidAt for warehouse emit: ${paidAt}`);
  }

  // Self-heal guard: only a CURRENTLY-paid order is emitted. A redelivery for an order that has
  // moved on (refunded/cancelled) must not re-assert paid — surface the skip (rule 12).
  const state = String(order.state);
  if (state !== "paid") {
    console.warn(`[order] warehouse emit skipped for order ${orderId}: state is '${state}', not 'paid'`);
    return { externalId, sourceVersion, lineCount: 0, clickRefCount: 0, skipped: true };
  }

  // The go-live test probe (channel='test') is a real 50c order that reaches
  // 'paid' then is refunded after cutover. It must never land in the warehouse
  // facts: order_fact has no channel column, so the commerce-analytics
  // channel='test' exclusion cannot reach an emitted row and it would inflate
  // warehouse revenue / order count / AOV permanently (the refund emits a
  // refund_fact but leaves the order_fact row). Skip the emit for test orders.
  if (String(order.channel ?? "") === "test") {
    return { externalId, sourceVersion, lineCount: 0, clickRefCount: 0, skipped: true };
  }

  const linesRead = await sb
    .from("order_line")
    .select("id, variant_id, quantity, unit_price_cents")
    .eq("shop_id", shopId)
    .eq("order_id", orderId);
  if (linesRead.error) throw linesRead.error;
  const orderLines = (linesRead.data ?? []) as Record<string, unknown>[];

  // Resolve order_line.variant_id → sku_dim.id the same way applyOrder does (sku_id is
  // nullable: an unresolved variant emits a line with sku_id=null rather than dropping it).
  //
  // NAMESPACE DEPENDENCY: sku_dim.external_id is the Shopify variant GID
  // (gid://shopify/ProductVariant/...); order_line.variant_id is the OWNED-catalog StoreVariant.id
  // (catalog.ts, John's #5). These namespaces only join once the owned catalog populates sku_dim
  // with external_ids that equal the catalog variant ids. Until #5 lands, native lines resolve to
  // sku_id=null — so sku_pnl / sku_velocity / stockout_forecast under-count native order lines.
  // We do NOT guess the mapping here (the spec: don't guess the analytics contract); the tolerant
  // null is the safe, non-fabricating behavior and the upsert stays correct when the join later works.
  const variantToSku = new Map<string, string>();
  if (orderLines.length) {
    const skuRead = await sb.from("sku_dim").select("id, external_id").eq("shop_id", shopId);
    if (skuRead.error) throw skuRead.error;
    for (const r of (skuRead.data ?? []) as Record<string, unknown>[]) {
      variantToSku.set(String(r.external_id), String(r.id));
    }
  }

  // order_fact: warehouse currency convention is uppercase ISO (Shopify-origin rows store
  // 'USD'); the OLTP cart/order snapshot is lowercase ('usd' for Stripe). Uppercase on emit
  // so native + Shopify rows aggregate together. discount_cents is 0 (line-level discounts
  // are not modeled in the pilot). order_number is the order id (the orders table carries no
  // human order number; analytics keys on external_id, not order_number).
  const orderFactUp = await sb
    .from("order_fact")
    .upsert(
      {
        shop_id: shopId,
        external_id: externalId,
        order_number: orderId,
        created_at_source: String(order.created_at),
        total_cents: Number(order.total_cents),
        subtotal_cents: Number(order.subtotal_cents),
        shipping_cents: Number(order.shipping_cents),
        tax_cents: Number(order.tax_cents),
        discount_cents: 0,
        currency: String(order.currency).toUpperCase(),
        financial_status: "paid",
        source_version: sourceVersion,
      },
      { onConflict: "shop_id,external_id" },
    )
    .select("id")
    .single();
  if (orderFactUp.error) throw orderFactUp.error;
  if (!orderFactUp.data) throw new Error("order_fact upsert returned no row");
  const orderFactId = String((orderFactUp.data as Record<string, unknown>).id);

  if (orderLines.length) {
    const lineRows = orderLines.map((l) => {
      const variantId = String(l.variant_id);
      const qty = Number(l.quantity);
      const unit = Number(l.unit_price_cents);
      return {
        shop_id: shopId,
        order_id: orderFactId,
        sku_id: variantToSku.get(variantId) ?? null,
        external_line_id: orderLineGid(String(l.id)),
        quantity: qty,
        price_cents: unit,
        total_cents: unit * qty,
      };
    });
    const lineUp = await sb
      .from("order_line_fact")
      .upsert(lineRows, { onConflict: "order_id,external_line_id" });
    if (lineUp.error) throw lineUp.error;
  }

  const clickRefCount = await emitAdClickRefs(sb, shopId, orderFactId, order.attribution);

  return { externalId, sourceVersion, lineCount: orderLines.length, clickRefCount, skipped: false };
}

/**
 * Replay captured ad click-ids from the order's attribution snapshot as ad_click_ref rows —
 * the SAME (order_id, platform, click_id) breadcrumb the Shopify path writes via
 * applyAttribution. Only emits for click-ids actually present in the snapshot; an empty/absent
 * snapshot writes nothing (don't fabricate attribution).
 */
async function emitAdClickRefs(
  sb: ReturnType<typeof getSupabase>,
  shopId: string,
  orderFactId: string,
  rawAttribution: unknown,
): Promise<number> {
  if (!rawAttribution || typeof rawAttribution !== "object") return 0;
  const snapshot = rawAttribution as AttributionSnapshot;
  const clickIds = snapshot.clickIds;
  if (!clickIds || typeof clickIds !== "object") return 0;

  let count = 0;
  for (const kind of CLICK_KEYS) {
    const value = clickIds[kind];
    if (!value) continue;
    const { error } = await sb.from("ad_click_ref").upsert(
      {
        shop_id: shopId,
        order_id: orderFactId,
        platform: clickIdPlatform(kind),
        click_id: value,
        utm: snapshot.utm ?? {},
      },
      { onConflict: "order_id,platform,click_id" },
    );
    if (error) throw error;
    count += 1;
  }
  return count;
}
