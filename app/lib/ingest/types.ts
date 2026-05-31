export type LocationRow = {
  shop_id: string;
  external_id: string;
  name: string;
  active: boolean;
};

export type SkuRow = {
  shop_id: string;
  external_id: string;
  product_id: string;
  inventory_item_id: string | null;
  sku: string | null;
  title: string;
  unit_cost_cents: number | null;
  currency: string;
  tags: string[];
};

export type InventoryRow = {
  shop_id: string;
  sku_id: string;
  location_id: string;
  available: number;
  observed_at: string;
  source_version: number;
};

export type OrderRow = {
  shop_id: string;
  external_id: string;
  order_number: string;
  created_at_source: string;
  total_cents: number;
  subtotal_cents: number;
  shipping_cents: number;
  tax_cents: number;
  discount_cents: number;
  currency: string;
  financial_status: string | null;
  source_version: number;
};

// sku is carried as the variant GID; the writer resolves it to sku_dim.id.
export type OrderLineRow = {
  sku_external_id: string | null;
  external_line_id: string;
  quantity: number;
  price_cents: number;
  total_cents: number;
};
