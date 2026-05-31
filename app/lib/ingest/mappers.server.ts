import type { LocationRow, SkuRow, OrderRow, OrderLineRow } from "./types";

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
type OrderLineNode = {
  id: string;
  quantity: number;
  variant?: { id?: string | null } | null;
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
  };
}

export function mapOrderLines(o: OrderNode): OrderLineRow[] {
  return (o.lineItems?.nodes ?? []).map((ln) => {
    const priceCents = moneyToCents(amount(ln.originalUnitPriceSet));
    return {
      sku_external_id: ln.variant?.id ?? null,
      external_line_id: ln.id,
      quantity: ln.quantity,
      price_cents: priceCents,
      total_cents: priceCents * ln.quantity,
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseOrderWebhook(p: Record<string, any>): {
  order: ParsedOrderHeader;
  lines: OrderLineRow[];
} {
  const updatedAt = String(p.updated_at ?? p.created_at);
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
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lines: OrderLineRow[] = (p.line_items ?? []).map((ln: Record<string, any>) => {
    const priceCents = moneyToCents(ln.price);
    return {
      sku_external_id: ln.variant_id ? `gid://shopify/ProductVariant/${ln.variant_id}` : null,
      external_line_id: String(ln.admin_graphql_api_id),
      quantity: Number(ln.quantity ?? 0),
      price_cents: priceCents,
      total_cents: priceCents * Number(ln.quantity ?? 0),
    };
  });
  return { order, lines };
}
