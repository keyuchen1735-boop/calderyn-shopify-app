// app/lib/seed/types.ts
//
// Row shapes for the demo-store seed dataset. Each interface mirrors the
// Supabase table it is written to (snake_case, *_cents integers) so the
// writer can upsert rows without reshaping.

export interface SeedConfig {
  shopId: string;
  /** Anchor day (YYYY-MM-DD). Time windows are derived backwards from here. */
  today: string;
  /** PRNG seed; fixed default keeps the dataset stable run-over-run. */
  rngSeed?: number;
}

export interface LocationRow {
  id: string;
  shop_id: string;
  external_id: string;
  name: string;
  country: string;
  region: string;
  city: string;
  active: boolean;
  created_at: string;
}

export interface OrderRow {
  id: string;
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
  financial_status: string;
  customer_country: string;
  customer_region: string;
  customer_city: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  source_version: number;
  created_at: string;
}

export interface OrderLineRow {
  id: string;
  shop_id: string;
  order_id: string;
  sku_id: string;
  external_line_id: string;
  quantity: number;
  price_cents: number;
  total_cents: number;
  unit_cost_cents_snapshot: number;
}

export interface FulfillmentRow {
  id: string;
  shop_id: string;
  order_id: string;
  external_id: string;
  location_id: string;
  status: string;
  shipped_at: string;
  source_version: number;
}

export interface InventoryLevelRow {
  shop_id: string;
  sku_id: string;
  location_id: string;
  available: number;
  observed_at: string;
  source_version: number;
}

export interface CogsRow {
  id: string;
  shop_id: string;
  sku_id: string;
  unit_cost_cents: number;
  effective_from: string;
  effective_to: string | null;
  source: string;
}

export interface SkuPnlRow {
  id: string;
  shop_id: string;
  sku_id: string;
  day: string;
  revenue_cents: number;
  cogs_cents: number;
  ad_spend_attrib_cents: number;
  return_cents: number;
  ship_cost_cents: number;
  contribution_margin_cents: number;
}

export interface SkuVelocityRow {
  id: string;
  shop_id: string;
  sku_id: string;
  window_days: number;
  units: number;
  computed_at: string;
}

export interface StockoutForecastRow {
  id: string;
  shop_id: string;
  sku_id: string;
  days_of_cover: number;
  computed_at: string;
}

export interface CampaignRow {
  id: string;
  shop_id: string;
  platform: "meta" | "google" | "tiktok";
  external_id: string;
  name: string;
  status: string;
  objective: string | null;
  daily_budget_cents: number;
  currency: string;
  geo_targets: string[];
  created_at_source: string;
  last_synced_at: string;
}

export interface AdSpendRow {
  id: string;
  shop_id: string;
  campaign_id: string;
  day: string;
  spend_cents: number;
  impressions: number;
  clicks: number;
  conversions: number;
  revenue_attrib_cents: number;
  polled_at: string;
}

export interface AttributionRow {
  id: string;
  shop_id: string;
  order_id: string;
  campaign_id: string | null;
  platform: "meta" | "google" | "tiktok" | null;
  attributed_revenue_cents: number;
  attribution_method: string;
  confidence: string;
}

export interface CreativeSkuMapRow {
  id: string;
  shop_id: string;
  platform: "meta" | "google" | "tiktok";
  creative_id: string;
  creative_label: string;
  sku_id: string;
  confidence: number;
  source: string;
  confirmed_at: string;
}

export interface AdEngagementRow {
  id: string;
  shop_id: string;
  campaign_id: string;
  ad_external_id: string;
  ad_name: string;
  day: string;
  impressions: number;
  link_clicks: number;
  reactions: number;
  comments: number;
  shares: number;
  saves: number;
  post_engagement: number;
  polled_at: string;
}

export interface CampaignGradeRow {
  id: string;
  shop_id: string;
  campaign_id: string;
  day_bucket: string;
  window_days: number;
  grade: string;
  roas: number;
  break_even_roas: number;
  margin: number;
  confidence: string;
  spend_cents: number;
  revenue_cents: number;
  cogs_cents: number;
  computed_at: string;
}

export interface SkuRow {
  id: string;
  shop_id: string;
  external_id: string;
  product_id: string;
  inventory_item_id: string;
  sku: string;
  title: string;
  category: string;
  price_tier: string;
  unit_cost_cents: number;
  currency: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}
