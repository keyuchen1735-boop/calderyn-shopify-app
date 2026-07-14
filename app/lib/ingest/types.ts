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
  inventory_policy: "deny" | "continue" | null;
  inventory_tracked: boolean;
  sku: string | null;
  title: string;
  unit_cost_cents: number | null;
  retail_price_cents: number | null;
  product_status: string | null;
  currency: string;
  // Product facets (inventory slicing). `category` carries Shopify productType.
  category: string | null;
  vendor: string | null;
  // Shopify featured-image url, denormalized per variant for the mirror->product_media
  // promote (#13.promote). Null when the product has no image.
  image_url: string | null;
  tags: string[];
  collections: string[];
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
  // Coarse shipping destination only. Do not add street, postal, recipient,
  // contact, or other customer-identifying address fields to this fact row.
  customer_city: string | null;
  customer_region: string | null;
  customer_country: string | null;
  // Non-null means destination presence (including a legitimate no-address
  // result) has already been checked. Legacy rows remain null for repair.
  destination_repair_checked_at: string;
  source_version: number;
  landing_site: string | null;
  referring_site: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
};

// sku is carried as the variant GID; the writer resolves it to sku_dim.id.
export type OrderLineRow = {
  sku_external_id: string | null;
  external_line_id: string;
  quantity: number;
  price_cents: number;
  total_cents: number;
  // Total line weight in grams (variant_unit_grams × quantity).
  // Null when the variant or its inventoryItem measurement is absent or has a
  // zero-value weight (treated as "unknown" rather than "weighs nothing").
  // Source: variant.inventoryItem.measurement.weight on the Admin GraphQL API;
  // non-GRAMS units (KILOGRAMS, POUNDS, OUNCES) are converted at mapper time.
  grams: number | null;
};
