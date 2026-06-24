import type { LocationRow, SkuRow, OrderRow, OrderLineRow } from "./types";
import { parseLandingSite } from "../attribution/parse";
import type { AttributionSignals } from "../attribution/types";
import { buildSkuTitle } from "../sku-title";

export function gidToId(gid: string): string {
  const m = gid.match(/\/([^/]+)$/);
  return m ? m[1] : gid;
}

export function moneyToCents(amount: string | number | null | undefined): number {
  if (amount === null || amount === undefined || amount === "") return 0;
  return Math.round(Number(amount) * 100);
}

type LocationNode = { id: string; name: string; isActive?: boolean };
type ProductNode = {
  id: string;
  title: string;
  vendor?: string | null;
  productType?: string | null;
  tags?: string[] | null;
  collections?: { nodes: Array<{ title: string | null }> } | null;
};
type VariantNode = {
  id: string;
  sku?: string | null;
  title?: string | null;
  inventoryPolicy?: string | null;
  inventoryItem?: {
    id?: string | null;
    tracked?: boolean | null;
    unitCost?: { amount?: string | null } | null;
  } | null;
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
  const unitCost = variant.inventoryItem?.unitCost?.amount;
  const inventoryPolicy = variant.inventoryPolicy?.toLowerCase();
  // Product facets for inventory slicing. `category` carries Shopify's
  // productType (the inventory page's "type" facet); empty strings are nulled so
  // a blank Shopify field doesn't render a dead facet.
  const productType = product.productType?.trim() || null;
  const vendor = product.vendor?.trim() || null;
  const collections = (product.collections?.nodes ?? [])
    .map((c) => c.title?.trim())
    .filter((t): t is string => !!t);
  return {
    shop_id: shopId,
    external_id: variant.id,
    product_id: product.id,
    inventory_item_id: variant.inventoryItem?.id ?? null,
    inventory_policy:
      inventoryPolicy === "deny" || inventoryPolicy === "continue" ? inventoryPolicy : null,
    inventory_tracked: variant.inventoryItem?.tracked === true,
    sku: variant.sku ?? null,
    // "<product> — <variant>" with any repeated product name stripped from the
    // variant (Shopify sample options often repeat it); see buildSkuTitle.
    title: buildSkuTitle(product.title, variant.title),
    unit_cost_cents: unitCost != null ? moneyToCents(unitCost) : null,
    currency: "USD",
    category: productType,
    vendor,
    tags: (product.tags ?? []).map((t) => t.trim()).filter(Boolean),
    collections,
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

type RawProductVariant = {
  id?: string | number;
  admin_graphql_api_id?: string;
  inventory_item_id?: string | number | null;
  sku?: string | null;
  title?: string | null;
  inventory_policy?: string | null;
  inventory_management?: string | null;
};
type RawProductWebhook = {
  id?: string | number;
  admin_graphql_api_id?: string;
  title?: string;
  vendor?: string | null;
  product_type?: string | null;
  tags?: string | null;
  variants?: RawProductVariant[];
};

/** Normalize products/update into sku_dim rows (shop_id is supplied by worker). */
export function parseProductWebhook(
  p: RawProductWebhook,
): Array<Omit<SkuRow, "shop_id" | "unit_cost_cents" | "collections">> {
  const productId = p.admin_graphql_api_id ??
    (p.id != null ? `gid://shopify/Product/${p.id}` : null);
  if (!productId) throw new Error("products webhook missing product id");
  const tags = String(p.tags ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);

  return (p.variants ?? []).map((variant) => {
    const externalId = variant.admin_graphql_api_id ??
      (variant.id != null ? `gid://shopify/ProductVariant/${variant.id}` : null);
    if (!externalId) throw new Error("products webhook variant missing id");
    const policy = variant.inventory_policy?.toLowerCase();
    return {
      external_id: externalId,
      product_id: productId,
      inventory_item_id:
        variant.inventory_item_id == null
          ? null
          : `gid://shopify/InventoryItem/${variant.inventory_item_id}`,
      inventory_policy: policy === "continue" ? "continue" : policy === "deny" ? "deny" : null,
      inventory_tracked: variant.inventory_management != null,
      sku: variant.sku ?? null,
      title: buildSkuTitle(String(p.title ?? ""), variant.title),
      currency: "USD",
      category: p.product_type?.trim() || null,
      vendor: p.vendor?.trim() || null,
      tags,
    };
  });
}

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

// One refunded line. sku_external_id is the variant GID; the transform worker
// resolves it to sku_dim.id. external_line_id is the refund-line GID — the
// idempotent upsert key for refund_fact.
export type ParsedRefundLine = {
  sku_external_id: string | null;
  external_line_id: string;
  quantity: number;
  subtotal_cents: number;
};

export type ParsedRefund = {
  external_id: string;
  // gid://shopify/Order/<id>; null when the payload omits order_id (the worker
  // resolves it to order_fact.id, leaving order_id null if unresolved).
  order_external_id: string | null;
  processed_at: string;
  source_version: number;
  lines: ParsedRefundLine[];
};

type RawRefundLineItem = {
  id?: string | number;
  quantity?: number;
  subtotal?: string | number | null;
  subtotal_set?: { shop_money?: { amount?: string | number | null } | null } | null;
  line_item?: { variant_id?: string | number | null } | null;
};
type RawRefundWebhook = {
  admin_graphql_api_id?: string | number;
  id?: string | number;
  order_id?: string | number | null;
  created_at?: string;
  processed_at?: string;
  refund_line_items?: RawRefundLineItem[];
};

// Normalize a REST `refunds/create` webhook body into refund-line rows the
// transform worker resolves to refund_fact. Refund revenue uses the shop-money
// subtotal; quantity is the refunded unit count. Like parseOrderWebhook, a
// missing id fails loudly so a malformed payload is retried/DLQ'd rather than
// collapsed onto a sentinel external id.
export function parseRefundWebhook(p: RawRefundWebhook): ParsedRefund {
  const externalId = p.admin_graphql_api_id
    ? String(p.admin_graphql_api_id)
    : p.id != null
      ? `gid://shopify/Refund/${p.id}`
      : null;
  if (!externalId) throw new Error("refunds webhook missing refund id");
  const processedAt = String(p.processed_at ?? p.created_at ?? new Date().toISOString());
  const lines: ParsedRefundLine[] = (p.refund_line_items ?? []).map((rli) => {
    if (rli.id == null) throw new Error("refund line item missing id");
    const amount = rli.subtotal_set?.shop_money?.amount ?? rli.subtotal;
    return {
      sku_external_id: rli.line_item?.variant_id
        ? `gid://shopify/ProductVariant/${rli.line_item.variant_id}`
        : null,
      external_line_id: `gid://shopify/RefundLineItem/${rli.id}`,
      quantity: Number(rli.quantity ?? 0),
      subtotal_cents: moneyToCents(amount),
    };
  });
  return {
    external_id: externalId,
    order_external_id: p.order_id != null ? `gid://shopify/Order/${p.order_id}` : null,
    processed_at: processedAt,
    source_version: Date.parse(processedAt),
    lines,
  };
}

// Strip a `refunds/create` webhook body down to ONLY the fields parseRefundWebhook
// reads. The raw refund payload carries `transactions` (payment gateway data,
// receipts) and notes the app never uses; dropping them before anything is stored
// keeps refund_fact ingestion to product/quantity/amount only.
export function minimizeRefundWebhook(p: Record<string, unknown>): RawRefundWebhook {
  const rawLines = Array.isArray(p.refund_line_items)
    ? (p.refund_line_items as Array<Record<string, unknown>>)
    : [];
  return {
    admin_graphql_api_id: p.admin_graphql_api_id as string | number | undefined,
    id: p.id as string | number | undefined,
    order_id: p.order_id as string | number | null | undefined,
    created_at: p.created_at as string | undefined,
    processed_at: p.processed_at as string | undefined,
    refund_line_items: rawLines.map((rli) => {
      const ss = rli.subtotal_set as
        | { shop_money?: { amount?: string | number | null } | null }
        | null
        | undefined;
      const li = rli.line_item as { variant_id?: string | number | null } | null | undefined;
      const amount = ss?.shop_money?.amount;
      return {
        id: rli.id as string | number | undefined,
        quantity: rli.quantity as number | undefined,
        subtotal: rli.subtotal as string | number | null | undefined,
        subtotal_set: amount != null ? { shop_money: { amount } } : null,
        line_item: li?.variant_id != null ? { variant_id: li.variant_id } : null,
      };
    }),
  };
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
