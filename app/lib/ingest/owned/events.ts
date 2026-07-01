// Owned-event schema + validator (platform pivot Step 5 / IngestETL). The owned
// checkout emits fact-shaped events into raw_owned_event; this module is the single
// source of truth for that contract and the guard that keeps buyer PII out of the
// analytics warehouse.
import type { AttributionSignals } from "../../attribution/types";

export const OWNED_CHECKOUT_COMPLETED = "CHECKOUT_COMPLETED" as const;

export interface OwnedOrderLine {
  external_line_id: string;
  variant_id: string | null; // owned variant_dim.id == sku_dim.id (repo invariant)
  quantity: number;
  price_cents: number;
  total_cents: number;
  grams?: number | null;
}

export interface OwnedCheckoutCompleted {
  event_id: string;
  type: typeof OWNED_CHECKOUT_COMPLETED;
  shop_id: string;
  occurred_at: string; // ISO 8601
  order: {
    external_id: string;
    order_number: string;
    total_cents: number;
    subtotal_cents: number;
    shipping_cents: number;
    tax_cents: number;
    discount_cents: number;
    currency: string;
    financial_status: "paid";
    buyer_id: string | null;
    attribution?: AttributionSignals;
  };
  lines: OwnedOrderLine[];
}

// Any of these keys anywhere in the payload is a PII leak — refuse the event
// (rule 12: fail visibly, never silently drop). Buyer PII lives ONLY in the OLTP
// buyer_dim store; the warehouse gets a pseudonymous buyer_id and nothing more.
const FORBIDDEN_PII_KEYS = new Set([
  "email", "phone", "name", "first_name", "last_name",
  "address", "address1", "address2", "shipping_address", "billing_address",
]);

function assertNoPii(obj: unknown, path: string): void {
  if (!obj || typeof obj !== "object") return;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (FORBIDDEN_PII_KEYS.has(k.toLowerCase())) {
      throw new Error(
        `owned event carries forbidden PII key '${path}${k}' — buyer PII must not reach the warehouse`,
      );
    }
    if (v && typeof v === "object") assertNoPii(v, `${path}${k}.`);
  }
}

function reqStr(v: unknown, name: string): string {
  if (typeof v !== "string" || v.length === 0) throw new Error(`owned event missing/invalid ${name}`);
  return v;
}
function reqNum(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`owned event missing/invalid ${name}`);
  return v;
}

export function parseOwnedCheckoutCompleted(raw: unknown): OwnedCheckoutCompleted {
  if (!raw || typeof raw !== "object") throw new Error("owned event payload is not an object");
  const p = raw as Record<string, unknown>;
  if (p.type !== OWNED_CHECKOUT_COMPLETED) {
    throw new Error(`unexpected owned event type ${String(p.type)}`);
  }
  assertNoPii(p, "");

  const order = p.order as Record<string, unknown> | undefined;
  if (!order || typeof order !== "object") throw new Error("owned event missing order");
  const linesRaw = Array.isArray(p.lines) ? (p.lines as Array<Record<string, unknown>>) : null;
  if (!linesRaw) throw new Error("owned event missing lines");

  const buyerId = order.buyer_id;
  if (buyerId !== null && typeof buyerId !== "string") {
    throw new Error("owned event order.buyer_id must be string|null");
  }
  if (order.financial_status !== "paid") {
    throw new Error(`owned event financial_status must be 'paid' (got ${String(order.financial_status)})`);
  }

  return {
    event_id: reqStr(p.event_id, "event_id"),
    type: OWNED_CHECKOUT_COMPLETED,
    shop_id: reqStr(p.shop_id, "shop_id"),
    occurred_at: reqStr(p.occurred_at, "occurred_at"),
    order: {
      external_id: reqStr(order.external_id, "order.external_id"),
      order_number: reqStr(order.order_number, "order.order_number"),
      total_cents: reqNum(order.total_cents, "order.total_cents"),
      subtotal_cents: reqNum(order.subtotal_cents, "order.subtotal_cents"),
      shipping_cents: reqNum(order.shipping_cents, "order.shipping_cents"),
      tax_cents: reqNum(order.tax_cents, "order.tax_cents"),
      discount_cents: reqNum(order.discount_cents, "order.discount_cents"),
      currency: reqStr(order.currency, "order.currency"),
      financial_status: "paid",
      buyer_id: (buyerId as string | null) ?? null,
      attribution: order.attribution as AttributionSignals | undefined,
    },
    lines: linesRaw.map((l, i) => ({
      external_line_id: reqStr(l.external_line_id, `lines[${i}].external_line_id`),
      variant_id: l.variant_id == null ? null : reqStr(l.variant_id, `lines[${i}].variant_id`),
      quantity: reqNum(l.quantity, `lines[${i}].quantity`),
      price_cents: reqNum(l.price_cents, `lines[${i}].price_cents`),
      total_cents: reqNum(l.total_cents, `lines[${i}].total_cents`),
      grams: l.grams == null ? null : reqNum(l.grams, `lines[${i}].grams`),
    })),
  };
}
