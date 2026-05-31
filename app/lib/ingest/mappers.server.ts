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
      // Pre-discount extended price (unit price × qty); line-level discounts
      // are not modeled in Slice 1.
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
};

export function parseOrderWebhook(p: RawOrderWebhook): {
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
  const lines: OrderLineRow[] = (p.line_items ?? []).map((ln) => {
    const priceCents = moneyToCents(ln.price);
    return {
      sku_external_id: ln.variant_id ? `gid://shopify/ProductVariant/${ln.variant_id}` : null,
      external_line_id: String(ln.admin_graphql_api_id),
      quantity: Number(ln.quantity ?? 0),
      price_cents: priceCents,
      // Pre-discount extended price (unit price × qty); line-level discounts
      // are not modeled in Slice 1.
      total_cents: priceCents * Number(ln.quantity ?? 0),
    };
  });
  return { order, lines };
}
