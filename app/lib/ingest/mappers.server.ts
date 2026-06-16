import type { LocationRow, SkuRow, OrderRow, OrderLineRow } from "./types";
import { parseLandingSite } from "../attribution/parse";
import type { AttributionSignals } from "../attribution/types";

export function gidToId(gid: string): string {
  const m = gid.match(/\/([^/]+)$/);
  return m ? m[1] : gid;
}

export function moneyToCents(amount: string | number | null | undefined): number {
  if (amount === null || amount === undefined || amount === "") return 0;
  return Math.round(Number(amount) * 100);
}

type LocationNode = { id: string; name: string; isActive?: boolean };
type ProductNode = { id: string; title: string };
type VariantNode = {
  id: string;
  sku?: string | null;
  title?: string | null;
  inventoryItem?: { id?: string | null; unitCost?: { amount?: string | null } | null } | null;
};
type Money = { shopMoney?: { amount?: string | null; currencyCode?: string | null } | null };
type OrderNode = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  displayFinancialStatus?: string | null;
  currentTotalPriceSet?: Money;
  currentSubtotalPriceSet?: Money;
  totalShippingPriceSet?: Money;
  currentTotalTaxSet?: Money;
  currentTotalDiscountsSet?: Money;
  lineItems?: { nodes?: OrderLineNode[] };
};
// Weight conversion factors to grams for each WeightUnit enum value.
const GRAMS_PER_UNIT: Record<string, number> = {
  GRAMS: 1,
  KILOGRAMS: 1000,
  POUNDS: 453.592,
  OUNCES: 28.3495,
};

// Returns total line grams (unit_grams × quantity), or null when weight is
// absent or zero (zero is treated as "not set" rather than "literally zero
// mass"). Non-GRAMS units are converted using GRAMS_PER_UNIT constants.
function weightToLineGrams(
  weight: { value: number; unit: string } | null | undefined,
  quantity: number,
): number | null {
  if (!weight || !weight.value) return null;
  const factor = GRAMS_PER_UNIT[weight.unit];
  if (factor === undefined) return null;
  return Math.round(weight.value * factor * quantity);
}

type OrderLineNode = {
  id: string;
  quantity: number;
  variant?: {
    id?: string | null;
    inventoryItem?: {
      measurement?: { weight?: { value: number; unit: string } | null } | null;
    } | null;
  } | null;
  originalUnitPriceSet?: Money;
};

function amount(m: Money | undefined): string | null {
  return m?.shopMoney?.amount ?? null;
}

export function mapLocation(shopId: string, n: LocationNode): LocationRow {
  return { shop_id: shopId, external_id: n.id, name: n.name, active: n.isActive ?? true };
}

export function mapVariantToSku(shopId: string, product: ProductNode, variant: VariantNode): SkuRow {
  const variantTitle = variant.title && variant.title !== "Default Title" ? variant.title : null;
  const unitCost = variant.inventoryItem?.unitCost?.amount;
  return {
    shop_id: shopId,
    external_id: variant.id,
    product_id: product.id,
    inventory_item_id: variant.inventoryItem?.id ?? null,
    sku: variant.sku ?? null,
    title: variantTitle ? `${product.title} — ${variantTitle}` : product.title,
    unit_cost_cents: unitCost != null ? moneyToCents(unitCost) : null,
    currency: "USD",
    tags: [],
  };
}

export function mapOrder(shopId: string, o: OrderNode): OrderRow {
  return {
    shop_id: shopId,
    external_id: o.id,
    order_number: o.name,
    created_at_source: o.createdAt,
    total_cents: moneyToCents(amount(o.currentTotalPriceSet)),
    subtotal_cents: moneyToCents(amount(o.currentSubtotalPriceSet)),
    shipping_cents: moneyToCents(amount(o.totalShippingPriceSet)),
    tax_cents: moneyToCents(amount(o.currentTotalTaxSet)),
    discount_cents: moneyToCents(amount(o.currentTotalDiscountsSet)),
    currency: o.currentTotalPriceSet?.shopMoney?.currencyCode ?? "USD",
    financial_status: o.displayFinancialStatus ?? null,
    source_version: Date.parse(o.updatedAt),
    // backfill (GraphQL) does not carry landing/UTM — null them.
    landing_site: null,
    referring_site: null,
    utm_source: null,
    utm_medium: null,
    utm_campaign: null,
    utm_content: null,
    utm_term: null,
  };
}

export function mapOrderLines(o: OrderNode): OrderLineRow[] {
  return (o.lineItems?.nodes ?? []).map((ln) => {
    const priceCents = moneyToCents(amount(ln.originalUnitPriceSet));
    const weight = ln.variant?.inventoryItem?.measurement?.weight ?? null;
    return {
      sku_external_id: ln.variant?.id ?? null,
      external_line_id: ln.id,
      quantity: ln.quantity,
      price_cents: priceCents,
      // Pre-discount extended price (unit price × qty); line-level discounts
      // are not modeled in Slice 1.
      total_cents: priceCents * ln.quantity,
      // Total line grams = variant unit grams × quantity.
      // Null when the variant, inventoryItem, or weight value is absent/zero.
      grams: weightToLineGrams(weight, ln.quantity),
    };
  });
}

// ---------------------------------------------------------------------------
// Webhook parsers — normalize REST-shaped Shopify webhook payloads into
// intermediate shapes the transform worker can resolve to fact rows.
// ---------------------------------------------------------------------------

export type ParsedInventory = {
  inventory_item_external_id: string;
  location_external_id: string;
  available: number;
  observed_at: string;
  source_version: number;
};

export function parseInventoryWebhook(p: Record<string, unknown>): ParsedInventory {
  const updatedAt = String(p.updated_at ?? new Date().toISOString());
  return {
    inventory_item_external_id: `gid://shopify/InventoryItem/${p.inventory_item_id}`,
    location_external_id: `gid://shopify/Location/${p.location_id}`,
    available: Number(p.available ?? 0),
    observed_at: updatedAt,
    source_version: Date.parse(updatedAt),
  };
}

// ParsedOrderHeader excludes shop_id — the caller (transform worker) supplies it.
export type ParsedOrderHeader = Omit<OrderRow, "shop_id">;

// Minimal shape of the REST `orders/create` webhook body — only the fields we
// read. Typed explicitly (rather than `any`) so the parse boundary is checked;
// every field is optional because external payloads are not guaranteed.
type RawMoneySet = { shop_money?: { amount?: string | number | null } | null };
type RawOrderLineItem = {
  admin_graphql_api_id?: string | number;
  quantity?: number;
  price?: string | number | null;
  variant_id?: string | number | null;
};
type RawOrderWebhook = {
  admin_graphql_api_id?: string | number;
  name?: string | number;
  created_at?: string;
  updated_at?: string;
  total_price?: string | number | null;
  subtotal_price?: string | number | null;
  total_shipping_price_set?: RawMoneySet | null;
  total_tax?: string | number | null;
  total_discounts?: string | number | null;
  currency?: string | null;
  financial_status?: string | null;
  line_items?: RawOrderLineItem[];
  landing_site?: string | null;
  referring_site?: string | null;
};

export function parseOrderWebhook(p: RawOrderWebhook): {
  order: ParsedOrderHeader;
  lines: OrderLineRow[];
  clickRef: AttributionSignals;
} {
  const updatedAt = String(p.updated_at ?? p.created_at ?? new Date().toISOString());
  const landingSite = p.landing_site ?? null;
  const referringSite = p.referring_site ?? null;
  const { utm, clickIds } = parseLandingSite(landingSite);
  // Fail loudly on a missing id rather than coercing to the string "undefined",
  // which would collapse every malformed order/line onto one sentinel external
  // id and silently overwrite real rows. Shopify always sends this field.
  if (!p.admin_graphql_api_id) {
    throw new Error("orders webhook missing admin_graphql_api_id");
  }
  const order: ParsedOrderHeader = {
    external_id: String(p.admin_graphql_api_id),
    order_number: String(p.name),
    created_at_source: String(p.created_at),
    total_cents: moneyToCents(p.total_price),
    subtotal_cents: moneyToCents(p.subtotal_price),
    shipping_cents: moneyToCents(p.total_shipping_price_set?.shop_money?.amount),
    tax_cents: moneyToCents(p.total_tax),
    discount_cents: moneyToCents(p.total_discounts),
    currency: String(p.currency ?? "USD"),
    financial_status: p.financial_status ?? null,
    source_version: Date.parse(updatedAt),
    landing_site: landingSite,
    referring_site: referringSite,
    utm_source: utm.utm_source ?? null,
    utm_medium: utm.utm_medium ?? null,
    utm_campaign: utm.utm_campaign ?? null,
    utm_content: utm.utm_content ?? null,
    utm_term: utm.utm_term ?? null,
  };
  const lines: OrderLineRow[] = (p.line_items ?? []).map((ln) => {
    if (!ln.admin_graphql_api_id) {
      throw new Error("orders webhook line item missing admin_graphql_api_id");
    }
    const priceCents = moneyToCents(ln.price);
    return {
      sku_external_id: ln.variant_id ? `gid://shopify/ProductVariant/${ln.variant_id}` : null,
      external_line_id: String(ln.admin_graphql_api_id),
      quantity: Number(ln.quantity ?? 0),
      price_cents: priceCents,
      // Pre-discount extended price (unit price × qty); line-level discounts
      // are not modeled in Slice 1.
      total_cents: priceCents * Number(ln.quantity ?? 0),
      // REST webhook payload does not include variant weight — grams is always
      // null here. The backfill (GraphQL) path populates it via mapOrderLines.
      grams: null,
    };
  });
  return { order, lines, clickRef: { utm, clickIds, referringSite } };
}

// Strip an `orders/create` webhook body down to ONLY the fields the ingest
// pipeline reads (the same set parseOrderWebhook consumes). Shopify always
// includes customer PII on this webhook — name, email, phone, billing/shipping
// addresses, notes, IP — which the app never uses; dropping it before anything
// is stored keeps the data footprint to order totals + line items (Shopify
// protected-customer-data Level 1). landing_site/referring_site are marketing
// URLs (used for attribution), not restricted customer fields, so they stay.
export function minimizeOrderWebhook(p: Record<string, unknown>): RawOrderWebhook {
  const ship = p.total_shipping_price_set as RawMoneySet | null | undefined;
  const shipAmount = ship?.shop_money?.amount;
  const rawLines = Array.isArray(p.line_items)
    ? (p.line_items as Array<Record<string, unknown>>)
    : [];
  return {
    admin_graphql_api_id: p.admin_graphql_api_id as string | number | undefined,
    name: p.name as string | number | undefined,
    created_at: p.created_at as string | undefined,
    updated_at: p.updated_at as string | undefined,
    total_price: p.total_price as string | number | null | undefined,
    subtotal_price: p.subtotal_price as string | number | null | undefined,
    total_shipping_price_set: shipAmount != null ? { shop_money: { amount: shipAmount } } : null,
    total_tax: p.total_tax as string | number | null | undefined,
    total_discounts: p.total_discounts as string | number | null | undefined,
    currency: p.currency as string | null | undefined,
    financial_status: p.financial_status as string | null | undefined,
    line_items: rawLines.map((ln) => ({
      admin_graphql_api_id: ln.admin_graphql_api_id as string | number | undefined,
      quantity: ln.quantity as number | undefined,
      price: ln.price as string | number | null | undefined,
      variant_id: ln.variant_id as string | number | null | undefined,
    })),
    landing_site: p.landing_site as string | null | undefined,
    referring_site: p.referring_site as string | null | undefined,
  };
}
