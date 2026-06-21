// app/lib/seed/dataset.ts
//
// Deterministic demo-store dataset generator: one believable DTC outdoor
// brand ("Peak & Pine Outfitters") whose facts embed the real situations the
// engine's detectors exist to catch. Pure — no I/O, no Date.now(); the writer
// script (scripts/seed-demo.ts) owns persistence.

import { mulberry32, seedFromString } from "./rng";
import type {
  AdEngagementRow,
  AdSpendRow,
  AttributionRow,
  CampaignGradeRow,
  CampaignRow,
  CogsRow,
  CreativeSkuMapRow,
  FulfillmentRow,
  RefundRow,
  InventoryLevelRow,
  LocationRow,
  OrderLineRow,
  OrderRow,
  SeedConfig,
  SkuPnlRow,
  SkuRow,
  SkuVelocityRow,
  StockoutForecastRow,
} from "./types";

export type { SeedConfig } from "./types";

/** SKUs that anchor a scenario arc; resolved ids for tests and the runner. */
export interface ScenarioRefs {
  heroTeeSkuId: string; // Summit Logo Tee M — stocked out while ads spend
  hoodieLSkuId: string; // Ridgeline Hoodie L — reorder_timing
  packSkuId: string; // Crestline Pack 28L — scaling_sku_fulfillment_risk
  duffelSkuId: string; // Basecamp Duffel — margin_erosion + cogs_drift
  windbreakerSSkuId: string; // Alpine Windbreaker S — return_rate_hidden_loss
  bottleSkuId: string; // Water Bottle — negative_unit_economics + west starved
  polesSkuId: string; // Trekking Poles — regional_shortage_risk (us-east)
  shellMSkuId: string; // Cascade Rain Shell M — wrong_location_concentration
}

export interface SeedDataset {
  locations: LocationRow[];
  skus: SkuRow[];
  orders: OrderRow[];
  orderLines: OrderLineRow[];
  fulfillments: FulfillmentRow[];
  refunds: RefundRow[];
  campaigns: CampaignRow[];
  adSpend: AdSpendRow[];
  attribution: AttributionRow[];
  creativeSkuMap: CreativeSkuMapRow[];
  adEngagement: AdEngagementRow[];
  campaignGrades: CampaignGradeRow[];
  inventoryLevels: InventoryLevelRow[];
  cogsFacts: CogsRow[];
  skuPnl: SkuPnlRow[];
  skuVelocity: SkuVelocityRow[];
  stockoutForecasts: StockoutForecastRow[];
  scenario: ScenarioRefs;
  /** List price per SKU id (order lines + margin checks derive from this). */
  listPriceCentsBySkuId: Record<string, number>;
}

const HISTORY_DAYS = 90;
/** Sun..Sat daily demand multipliers — weekends outsell midweek. */
const DOW_MULT = [1.4, 0.95, 0.85, 0.85, 0.95, 1.1, 1.5];
const REGIONS = ["us-east", "us-west", "us-central", "us-south"] as const;
const DEFAULT_REGION_WEIGHTS = [0.35, 0.25, 0.2, 0.2];
const REGION_CITY: Record<string, string> = {
  "us-east": "New York",
  "us-west": "Portland",
  "us-central": "Chicago",
  "us-south": "Atlanta",
};

function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Format 16 PRNG-derived bytes as a v4-shaped UUID (deterministic). */
function uuidFrom(rng: () => number): string {
  const hex = () => Math.floor(rng() * 256).toString(16).padStart(2, "0");
  const b = Array.from({ length: 16 }, hex);
  b[6] = "4" + b[6][1];
  b[8] = ((parseInt(b[8][0], 16) & 0x3) | 0x8).toString(16) + b[8][1];
  return `${b[0]}${b[1]}${b[2]}${b[3]}-${b[4]}${b[5]}-${b[6]}${b[7]}-${b[8]}${b[9]}-${b[10]}${b[11]}${b[12]}${b[13]}${b[14]}${b[15]}`;
}

// external_id mirrors real Shopify ingestion (gid://shopify/Location/<id>); a
// placeholder slug here makes the reallocate mutation fail "Invalid global id"
// on the location (P0-2). Names/regions carry the human identity.
const LOCATIONS = [
  { external_id: "gid://shopify/Location/7001", name: "Northeast DC — Edison, NJ", country: "US", region: "us-east", city: "Edison" },
  { external_id: "gid://shopify/Location/7002", name: "West DC — Reno, NV", country: "US", region: "us-west", city: "Reno" },
  { external_id: "gid://shopify/Location/7003", name: "Midwest DC — Columbus, OH", country: "US", region: "us-central", city: "Columbus" },
  { external_id: "gid://shopify/Location/7004", name: "Flagship Store — Austin, TX", country: "US", region: "us-south", city: "Austin" },
];

interface ProductSpec {
  handle: string;
  title: string;
  category: string;
  priceCents: number;
  costCents: number;
  variants: string[]; // size/variant labels; single-variant products use ["one-size"]
  /** Storewide units/day baseline, split across variants by variantWeights. */
  velocityPerDay: number;
  variantWeights?: number[]; // parallel to variants; defaults to equal split
  regionWeights?: number[]; // parallel to REGIONS; defaults to DEFAULT_REGION_WEIGHTS
}

// Price/cost pairs target realistic DTC retail margins (~60-72%). Velocities
// and skews are tuned so every scenario arc clears its detector's exact
// threshold (see __tests__/scenarios.test.ts) without spraying noise alerts
// from healthy SKUs.
const PRODUCTS: ProductSpec[] = [
  { handle: "summit-logo-tee", title: "Summit Logo Tee", category: "apparel", priceCents: 3200, costCents: 950, variants: ["S", "M", "L", "XL"], velocityPerDay: 16, variantWeights: [0.16, 0.44, 0.28, 0.12] },
  { handle: "trail-graphic-tee", title: "Trail Graphic Tee", category: "apparel", priceCents: 3400, costCents: 1050, variants: ["S", "M", "L"], velocityPerDay: 4, variantWeights: [0.3, 0.4, 0.3] },
  { handle: "ridgeline-hoodie", title: "Ridgeline Hoodie", category: "apparel", priceCents: 7800, costCents: 2600, variants: ["S", "M", "L", "XL"], velocityPerDay: 5, variantWeights: [0.15, 0.3, 0.35, 0.2] },
  { handle: "trailblazer-pants", title: "Trailblazer Pants", category: "apparel", priceCents: 9800, costCents: 3100, variants: ["30", "32", "34", "36"], velocityPerDay: 4.5, variantWeights: [0.2, 0.3, 0.3, 0.2] },
  { handle: "alpine-windbreaker", title: "Alpine Windbreaker", category: "outerwear", priceCents: 12900, costCents: 4400, variants: ["S", "M", "L"], velocityPerDay: 3, variantWeights: [0.34, 0.36, 0.3] },
  { handle: "cascade-rain-shell", title: "Cascade Rain Shell", category: "outerwear", priceCents: 15900, costCents: 5200, variants: ["S", "M", "L"], velocityPerDay: 2.5, variantWeights: [0.3, 0.44, 0.26], regionWeights: [0.5, 0.1, 0.2, 0.2] },
  { handle: "crestline-pack-28l", title: "Crestline Pack 28L", category: "gear", priceCents: 13900, costCents: 4800, variants: ["one-size"], velocityPerDay: 3 },
  { handle: "basecamp-duffel-45l", title: "Basecamp Duffel 45L", category: "gear", priceCents: 11900, costCents: 4100, variants: ["one-size"], velocityPerDay: 4 },
  { handle: "granite-trekking-poles", title: "Granite Trekking Poles", category: "gear", priceCents: 8900, costCents: 3000, variants: ["one-size"], velocityPerDay: 2, regionWeights: [0.45, 0.2, 0.15, 0.2] },
  { handle: "basecamp-water-bottle", title: "Basecamp Water Bottle 750ml", category: "accessories", priceCents: 2400, costCents: 750, variants: ["one-size"], velocityPerDay: 7 },
  { handle: "trail-socks-3pack", title: "Trail Running Socks 3-Pack", category: "accessories", priceCents: 2200, costCents: 650, variants: ["M", "L"], velocityPerDay: 4.5, variantWeights: [0.6, 0.4] },
  { handle: "switchback-cap", title: "Switchback Cap", category: "accessories", priceCents: 2800, costCents: 900, variants: ["one-size"], velocityPerDay: 3 },
];

/** Demo vendor per category — gives the inventory vendor facet a few values. */
const VENDOR_BY_CATEGORY: Record<string, string> = {
  apparel: "Summit Apparel Co",
  outerwear: "Alpine Outfitters",
  gear: "Trailhead Gear",
  accessories: "Basecamp Supply",
};

/** Curated demo collections from a product's velocity + category, so the
 * inventory collection facet has meaningful (and overlapping) groups to slice by. */
function seedCollections(p: ProductSpec): string[] {
  const out: string[] = [];
  if (p.velocityPerDay >= 5) out.push("Best Sellers");
  if (p.category === "outerwear") out.push("Weather Ready");
  if (p.category === "gear" || p.category === "accessories") out.push("Trail Essentials");
  return out;
}

/**
 * Real campaign objects the actions layer can mutate: the Meta ones live in
 * act_507175904037277 (created PAUSED with no ad sets, so they can never
 * deliver or spend); the TikTok one is the sandbox campaign already synced.
 * Google's developer token is test-account-only, so its ids are realistic
 * placeholders until a test account exists — Google actions are covered by
 * the mock-adapter test layer.
 */
export const SANDBOX_CAMPAIGN_IDS = {
  metaProspecting: "120247426475170026",
  metaRetargeting: "120247426476070026",
  metaBleeder: "120247426477610026",
  googleBrand: "20871450391",
  googlePmax: "20871450884",
  googleHydrationWest: "20871451307",
  tiktokSpark: "1786366759456785",
} as const;

interface CampaignSpec {
  key: keyof typeof SANDBOX_CAMPAIGN_IDS;
  platform: "meta" | "google" | "tiktok";
  name: string;
  objective: string;
  dailyBudgetCents: number;
  geoTargets: string[];
  /** [fromDaysAgo, toDaysAgo] inclusive phases with spend level + target ROAS. */
  phases: { fromDaysAgo: number; toDaysAgo: number; spendCents: number; roas: number }[];
  ctr: number;
  cvr: number;
  cpmCents: number;
}

const ALL_REGIONS = [...REGIONS];
const CAMPAIGNS: CampaignSpec[] = [
  {
    key: "metaProspecting", platform: "meta", name: "Prospecting — Advantage+ Shopping — US",
    objective: "conversions", dailyBudgetCents: 9000, geoTargets: ALL_REGIONS,
    phases: [{ fromDaysAgo: 89, toDaysAgo: 0, spendCents: 8600, roas: 3.2 }], ctr: 0.013, cvr: 0.03, cpmCents: 1400,
  },
  {
    key: "metaRetargeting", platform: "meta", name: "Retargeting — 30d Site Engagers",
    objective: "conversions", dailyBudgetCents: 4000, geoTargets: ALL_REGIONS,
    phases: [{ fromDaysAgo: 89, toDaysAgo: 0, spendCents: 3800, roas: 4.5 }], ctr: 0.022, cvr: 0.045, cpmCents: 1800,
  },
  {
    // The bleeder: scaled 5x ten days ago, then its product stocked out.
    key: "metaBleeder", platform: "meta", name: "Summit Tee — Creator Whitelisting Test",
    objective: "conversions", dailyBudgetCents: 45000, geoTargets: ["us-east", "us-west"],
    phases: [
      { fromDaysAgo: 30, toDaysAgo: 11, spendCents: 8000, roas: 1.6 },
      { fromDaysAgo: 10, toDaysAgo: 5, spendCents: 45000, roas: 0.7 },
      { fromDaysAgo: 4, toDaysAgo: 0, spendCents: 45000, roas: 0.1 },
    ], ctr: 0.011, cvr: 0.02, cpmCents: 1300,
  },
  {
    key: "googleBrand", platform: "google", name: "Brand Search — Exact — US",
    objective: "conversions", dailyBudgetCents: 3500, geoTargets: ALL_REGIONS,
    phases: [{ fromDaysAgo: 89, toDaysAgo: 0, spendCents: 3400, roas: 6.0 }], ctr: 0.045, cvr: 0.08, cpmCents: 6000,
  },
  {
    key: "googlePmax", platform: "google", name: "Performance Max — All Products",
    objective: "conversions", dailyBudgetCents: 12000, geoTargets: ALL_REGIONS,
    phases: [{ fromDaysAgo: 89, toDaysAgo: 0, spendCents: 11600, roas: 2.2 }], ctr: 0.012, cvr: 0.028, cpmCents: 1100,
  },
  {
    // Pushes the water bottle out west — where its stock just ran dry.
    key: "googleHydrationWest", platform: "google", name: "PMax — Hydration Push — West",
    objective: "conversions", dailyBudgetCents: 7000, geoTargets: ["us-west"],
    phases: [
      { fromDaysAgo: 45, toDaysAgo: 7, spendCents: 6700, roas: 1.6 },
      { fromDaysAgo: 6, toDaysAgo: 0, spendCents: 6700, roas: 0.3 },
    ], ctr: 0.012, cvr: 0.026, cpmCents: 1100,
  },
  {
    // TikTok Spark ads on the pack: spend ramping into a thin stock position.
    key: "tiktokSpark", platform: "tiktok", name: "Spark Ads — Crestline Pack UGC",
    objective: "conversions", dailyBudgetCents: 10000, geoTargets: [],
    phases: [
      { fromDaysAgo: 44, toDaysAgo: 8, spendCents: 4000, roas: 2.3 },
      { fromDaysAgo: 7, toDaysAgo: 0, spendCents: 10000, roas: 2.3 },
    ], ctr: 0.011, cvr: 0.022, cpmCents: 800,
  },
];

// Scenario tuning constants (referenced by both generation and tests).
/** Duffel: freight surcharge raised COGS +30% a week ago… */
export const DUFFEL_RAISED_COST_CENTS = 5330;
/** …while a 10% sitewide gear promo discounts its sale price. */
export const DUFFEL_PROMO_PRICE_CENTS = 10710;
/** Days ago the duffel cost hike + promo took effect. */
export const DUFFEL_SHIFT_DAYS_AGO = 7;
/** Alpine Windbreaker S sizing runs small — elevated refund rate. */
export const WINDBREAKER_S_REFUND_RATE = 0.27;
const BASE_REFUND_RATE = 0.02;

function priceTier(priceCents: number): string {
  if (priceCents < 3000) return "under_30";
  if (priceCents < 6000) return "30_60";
  if (priceCents < 15000) return "60_150";
  return "over_150";
}

export function generateSeedDataset(config: SeedConfig): SeedDataset {
  const rng = mulberry32(config.rngSeed ?? seedFromString(config.shopId));
  const createdAt = `${config.today}T00:00:00.000Z`;

  const locations: LocationRow[] = LOCATIONS.map((l) => ({
    id: uuidFrom(rng),
    shop_id: config.shopId,
    ...l,
    active: true,
    created_at: createdAt,
  }));

  const skus: SkuRow[] = [];
  const priceBySkuId = new Map<string, number>();
  // Deterministic per-variant inventory-item id sequence (loop order is stable).
  let invItemSeq = 0;
  for (const p of PRODUCTS) {
    for (const variant of p.variants) {
      const id = uuidFrom(rng);
      const suffix = variant === "one-size" ? "" : ` — ${variant}`;
      skus.push({
        id,
        shop_id: config.shopId,
        external_id: `variant-${p.handle}-${variant}`,
        product_id: `product-${p.handle}`,
        // Shopify-shaped global id (matches real ingestion's variant.inventoryItem.id);
        // a placeholder makes the reallocate mutation fail "Invalid global id" (P0-2).
        inventory_item_id: `gid://shopify/InventoryItem/${100000 + invItemSeq++}`,
        sku: `PP-${p.handle.toUpperCase().replace(/[^A-Z0-9]+/g, "-").slice(0, 16)}-${variant.toUpperCase()}`,
        title: `${p.title}${suffix}`,
        category: p.category,
        price_tier: priceTier(p.priceCents),
        unit_cost_cents: p.costCents,
        currency: "USD",
        vendor: VENDOR_BY_CATEGORY[p.category] ?? null,
        tags: [p.category, priceTier(p.priceCents)],
        collections: seedCollections(p),
        created_at: createdAt,
        updated_at: createdAt,
      });
      priceBySkuId.set(id, p.priceCents);
    }
  }

  const skuByExternalId = new Map(skus.map((s) => [s.external_id, s]));
  const mustSku = (externalId: string): SkuRow => {
    const sku = skuByExternalId.get(externalId);
    if (!sku) throw new Error(`seed catalog missing ${externalId}`);
    return sku;
  };
  const scenario: ScenarioRefs = {
    heroTeeSkuId: mustSku("variant-summit-logo-tee-M").id,
    hoodieLSkuId: mustSku("variant-ridgeline-hoodie-L").id,
    packSkuId: mustSku("variant-crestline-pack-28l-one-size").id,
    duffelSkuId: mustSku("variant-basecamp-duffel-45l-one-size").id,
    windbreakerSSkuId: mustSku("variant-alpine-windbreaker-S").id,
    bottleSkuId: mustSku("variant-basecamp-water-bottle-one-size").id,
    polesSkuId: mustSku("variant-granite-trekking-poles-one-size").id,
    shellMSkuId: mustSku("variant-cascade-rain-shell-M").id,
  };

  // --- Demand: per (day, region, sku) unit counts from velocity × seasonality.
  const specBySkuId = new Map<string, ProductSpec>();
  const variantShareBySkuId = new Map<string, number>();
  const regionWeightsBySkuId = new Map<string, number[]>();
  for (const p of PRODUCTS) {
    p.variants.forEach((variant, i) => {
      const sku = mustSku(`variant-${p.handle}-${variant}`);
      specBySkuId.set(sku.id, p);
      variantShareBySkuId.set(sku.id, p.variantWeights?.[i] ?? 1 / p.variants.length);
      regionWeightsBySkuId.set(sku.id, p.regionWeights ?? DEFAULT_REGION_WEIGHTS);
    });
  }

  const orders: OrderRow[] = [];
  const orderLines: OrderLineRow[] = [];
  const fulfillments: FulfillmentRow[] = [];
  const refunds: RefundRow[] = [];
  // Separate PRNG for refund uuids so they don't perturb the main rng stream —
  // the rest of the deterministic dataset stays byte-identical run-over-run.
  const refundRng = mulberry32(seedFromString(`${config.shopId}:refunds`));
  const skuById = new Map(skus.map((s) => [s.id, s]));
  const locationByRegion = new Map(locations.map((l) => [l.region, l]));
  const duffelShiftDay = addDays(config.today, -DUFFEL_SHIFT_DAYS_AGO);
  const returnsBySkuDay = new Map<string, number>(); // `${skuId}|${day}` -> cents
  let orderSeq = 10_000;
  let windbreakerOrderCount = 0;

  for (let i = 0; i < HISTORY_DAYS; i++) {
    const day = addDays(config.today, i - (HISTORY_DAYS - 1));
    const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
    const growth = 0.88 + 0.24 * (i / (HISTORY_DAYS - 1)); // gentle up-trend
    const dayMult = DOW_MULT[dow] * growth;

    // Units demanded today, per region then per sku.
    const demand = new Map<string, Map<string, number>>(); // region -> skuId -> units
    for (const sku of skus) {
      // Hero tee M sold out: no units move on the anchor day itself.
      if (sku.id === scenario.heroTeeSkuId && day === config.today) continue;
      const spec = specBySkuId.get(sku.id)!;
      const base = spec.velocityPerDay * variantShareBySkuId.get(sku.id)! * dayMult * (0.75 + 0.5 * rng());
      const weights = regionWeightsBySkuId.get(sku.id)!;
      REGIONS.forEach((region, r) => {
        const expected = base * weights[r];
        const units = Math.floor(expected) + (rng() < expected % 1 ? 1 : 0);
        if (units <= 0) return;
        const perRegion = demand.get(region) ?? new Map<string, number>();
        perRegion.set(sku.id, (perRegion.get(sku.id) ?? 0) + units);
        demand.set(region, perRegion);
      });
    }

    // Pack demanded units into 1-3 line orders fulfilled from the region's DC.
    for (const [region, perRegion] of demand) {
      const pool = [...perRegion.entries()].map(([skuId, units]) => ({ skuId, units }));
      while (pool.some((p) => p.units > 0)) {
        const lineCountRoll = rng();
        const lineTarget = lineCountRoll < 0.6 ? 1 : lineCountRoll < 0.9 ? 2 : 3;
        const orderId = uuidFrom(rng);
        const chosen: { skuId: string; qty: number }[] = [];
        for (let n = 0; n < lineTarget; n++) {
          const candidates = pool.filter((p) => p.units > 0 && !chosen.some((c) => c.skuId === p.skuId));
          if (!candidates.length) break;
          const pick = candidates[Math.floor(rng() * candidates.length)];
          const qty = Math.min(pick.units, rng() < 0.25 ? 2 : 1);
          pick.units -= qty;
          chosen.push({ skuId: pick.skuId, qty });
        }
        if (!chosen.length) break;

        let subtotal = 0;
        let containsWindbreakerS = false;
        const seq = orderSeq;
        const orderLineRows: OrderLineRow[] = [];
        chosen.forEach((c, idx) => {
          const sku = skuById.get(c.skuId)!;
          const isDuffelPromo = c.skuId === scenario.duffelSkuId && day >= duffelShiftDay;
          const price = isDuffelPromo ? DUFFEL_PROMO_PRICE_CENTS : priceBySkuId.get(c.skuId)!;
          const cost = isDuffelPromo ? DUFFEL_RAISED_COST_CENTS : sku.unit_cost_cents;
          if (c.skuId === scenario.windbreakerSSkuId) containsWindbreakerS = true;
          subtotal += price * c.qty;
          orderLineRows.push({
            id: uuidFrom(rng),
            shop_id: config.shopId,
            order_id: orderId,
            sku_id: c.skuId,
            external_line_id: `line-${seq}-${idx}`,
            quantity: c.qty,
            price_cents: price,
            total_cents: price * c.qty,
            unit_cost_cents_snapshot: cost,
          });
        });
        orderLines.push(...orderLineRows);

        const discount = rng() < 0.12 ? Math.round(subtotal * (0.1 + 0.05 * rng())) : 0;
        const shipping = subtotal >= 7500 ? 0 : 595;
        const tax = Math.round((subtotal - discount) * 0.0725);
        // Windbreaker-S refunds are counter-based and evenly interleaved
        // (exactly the arc's rate in every window, immune to rng drift across
        // anchor dates); the base rate stays random.
        const refunded = containsWindbreakerS
          ? Math.floor(++windbreakerOrderCount * WINDBREAKER_S_REFUND_RATE) >
            Math.floor((windbreakerOrderCount - 1) * WINDBREAKER_S_REFUND_RATE)
          : rng() < BASE_REFUND_RATE;
        const financialStatus = refunded ? (chosen.length > 1 ? "PARTIALLY_REFUNDED" : "REFUNDED") : "PAID";
        // A refunded order returns one whole line: the size-S windbreaker when
        // present (its elevated-return arc), else the first line.
        const returnedLine = refunded
          ? orderLineRows.find((l) => l.sku_id === scenario.windbreakerSSkuId) ?? orderLineRows[0]
          : null;
        if (returnedLine) {
          const key = `${returnedLine.sku_id}|${day}`;
          returnsBySkuDay.set(key, (returnsBySkuDay.get(key) ?? 0) + returnedLine.total_cents);
        }
        const hour = 9 + Math.floor(rng() * 13);
        const createdAtSource = `${day}T${String(hour).padStart(2, "0")}:${String(Math.floor(rng() * 60)).padStart(2, "0")}:00.000Z`;
        orderSeq += 1;
        if (returnedLine) {
          refunds.push({
            id: uuidFrom(refundRng),
            shop_id: config.shopId,
            order_id: orderId,
            sku_id: returnedLine.sku_id,
            external_id: `gid-refund-${orderSeq}`,
            external_line_id: `refund-line-${seq}`,
            quantity: returnedLine.quantity,
            subtotal_cents: returnedLine.total_cents,
            processed_at: createdAtSource,
            source_version: 1,
          });
        }

        orders.push({
          id: orderId,
          shop_id: config.shopId,
          external_id: `gid-order-${orderSeq}`,
          order_number: `#${orderSeq}`,
          created_at_source: createdAtSource,
          total_cents: subtotal + shipping + tax - discount,
          subtotal_cents: subtotal,
          shipping_cents: shipping,
          tax_cents: tax,
          discount_cents: discount,
          currency: "USD",
          financial_status: financialStatus,
          customer_country: "US",
          customer_region: region,
          customer_city: REGION_CITY[region] ?? null,
          utm_source: null,
          utm_medium: null,
          utm_campaign: null,
          source_version: 1,
          created_at: createdAtSource,
        });
        fulfillments.push({
          id: uuidFrom(rng),
          shop_id: config.shopId,
          order_id: orderId,
          external_id: `fulfill-${orderSeq}`,
          location_id: locationByRegion.get(region)!.id,
          status: "success",
          shipped_at: createdAtSource,
          source_version: 1,
        });
      }
    }
  }

  // --- Derived facts. Computed from the realized orders (not the velocity
  // targets) so inventory/velocity/P&L stay self-consistent with sales.
  const orderById = new Map(orders.map((o) => [o.id, o]));
  const fulfillByOrder = new Map(fulfillments.map((f) => [f.order_id, f]));
  const cutoff30 = addDays(config.today, -30);
  const cutoff7 = addDays(config.today, -6);

  const realized30 = new Map<string, Map<string, number>>(); // skuId -> region -> units
  const sold7 = new Map<string, number>();
  // Ship cost: $4.25 base per order + $0.75 per additional unit beyond the first.
  // Allocated to SKUs pro-rata by line quantity within each order.
  // (Computed below, after linesByOrderId is built, so both share one map.)
  const shipCostBySkuDay = new Map<string, number>();

  const pnlBySkuDay = new Map<string, { revenue: number; cogs: number }>();
  for (const l of orderLines) {
    const order = orderById.get(l.order_id)!;
    const day = order.created_at_source.slice(0, 10);
    const pnlKey = `${l.sku_id}|${day}`;
    const slot = pnlBySkuDay.get(pnlKey) ?? { revenue: 0, cogs: 0 };
    slot.revenue += l.total_cents;
    slot.cogs += l.unit_cost_cents_snapshot * l.quantity;
    pnlBySkuDay.set(pnlKey, slot);
    if (day >= cutoff7) sold7.set(l.sku_id, (sold7.get(l.sku_id) ?? 0) + l.quantity);
    if (day >= cutoff30) {
      const region = locById(locations, fulfillByOrder.get(order.id)!.location_id).region;
      const perRegion = realized30.get(l.sku_id) ?? new Map<string, number>();
      perRegion.set(region, (perRegion.get(region) ?? 0) + l.quantity);
      realized30.set(l.sku_id, perRegion);
    }
  }

  const coverDaysBySkuId = new Map(skus.map((s) => [s.id, 25 + rng() * 10]));
  const dailyDemand = (skuId: string, region: string): number =>
    (realized30.get(skuId)?.get(region) ?? 0) / 30;

  /** Today's stock per (sku, region) — arc SKUs pinned, healthy SKUs covered. */
  const todayStock = (skuId: string, region: string): number => {
    if (skuId === scenario.heroTeeSkuId) return 0;
    if (skuId === scenario.bottleSkuId && region === "us-west") return 0;
    if (skuId === scenario.polesSkuId && region === "us-east") return 8;
    if (skuId === scenario.shellMSkuId) {
      return region === "us-west" ? 380 : Math.max(8, Math.round(dailyDemand(skuId, region) * 20));
    }
    const daily = dailyDemand(skuId, region);
    if (daily <= 0) return 0;
    return Math.max(8, Math.round(daily * coverDaysBySkuId.get(skuId)!));
  };

  const inventoryLevels: InventoryLevelRow[] = [];
  let sourceVersion = 1;
  for (let i = 0; i < HISTORY_DAYS; i += 3) {
    const day = addDays(config.today, i - (HISTORY_DAYS - 1));
    const daysAgo = daysBetween(day, config.today);
    for (const sku of skus) {
      for (const loc of locations) {
        const base = todayStock(sku.id, loc.region);
        let available: number;
        if (sku.id === scenario.heroTeeSkuId) {
          // Bestseller sell-down: healthy a month ago, zero for the last 4 days.
          const healthy = Math.max(12, Math.round(dailyDemand(sku.id, loc.region) * 25));
          available = daysAgo <= 4 ? 0 : Math.round(healthy * Math.min(1, (daysAgo - 4) / 21));
        } else if (sku.id === scenario.bottleSkuId && loc.region === "us-west") {
          available = daysAgo <= 6 ? 0 : Math.round(60 * Math.min(1, (daysAgo - 6) / 18));
        } else {
          available = Math.max(0, Math.round(base * (0.8 + 0.5 * rng())));
        }
        inventoryLevels.push({
          shop_id: config.shopId,
          sku_id: sku.id,
          location_id: loc.id,
          available,
          observed_at: `${day}T06:00:00.000Z`,
          source_version: sourceVersion,
        });
      }
    }
    sourceVersion += 1;
  }
  // Anchor-day observation (latest read + the stocked-out 24h window).
  for (const sku of skus) {
    for (const loc of locations) {
      inventoryLevels.push({
        shop_id: config.shopId,
        sku_id: sku.id,
        location_id: loc.id,
        available: todayStock(sku.id, loc.region),
        observed_at: `${config.today}T12:00:00.000Z`,
        source_version: sourceVersion,
      });
    }
  }

  const effectiveFromDefault = `${addDays(config.today, -120)}T00:00:00.000Z`;
  const duffelShiftAt = `${duffelShiftDay}T00:00:00.000Z`;
  const cogsFacts: CogsRow[] = [];
  for (const sku of skus) {
    if (sku.id === scenario.duffelSkuId) {
      cogsFacts.push(
        { id: uuidFrom(rng), shop_id: config.shopId, sku_id: sku.id, unit_cost_cents: sku.unit_cost_cents, effective_from: effectiveFromDefault, effective_to: duffelShiftAt, source: "vendor_invoice" },
        { id: uuidFrom(rng), shop_id: config.shopId, sku_id: sku.id, unit_cost_cents: DUFFEL_RAISED_COST_CENTS, effective_from: duffelShiftAt, effective_to: null, source: "vendor_invoice" },
      );
      continue;
    }
    cogsFacts.push({ id: uuidFrom(rng), shop_id: config.shopId, sku_id: sku.id, unit_cost_cents: sku.unit_cost_cents, effective_from: effectiveFromDefault, effective_to: null, source: "vendor_invoice" });
  }

  // --- Ad campaigns + daily spend facts. Funnel metrics derive from each
  // campaign's CPM/CTR so rows stay internally coherent; revenue tracks the
  // phase's target ROAS (the bleeder's collapse is a phase change).
  const polledAt = `${config.today}T12:00:00.000Z`;
  const campaigns: CampaignRow[] = CAMPAIGNS.map((spec) => ({
    id: uuidFrom(rng),
    shop_id: config.shopId,
    platform: spec.platform,
    external_id: SANDBOX_CAMPAIGN_IDS[spec.key],
    name: spec.name,
    status: "active",
    objective: spec.objective,
    daily_budget_cents: spec.dailyBudgetCents,
    currency: "USD",
    geo_targets: spec.geoTargets,
    created_at_source: `${addDays(config.today, -spec.phases[0].fromDaysAgo)}T00:00:00.000Z`,
    last_synced_at: polledAt,
  }));
  const campaignIdByKey = new Map(CAMPAIGNS.map((spec, i) => [spec.key, campaigns[i].id]));

  const AOV_CENTS = 8000;
  const adSpend: AdSpendRow[] = [];
  CAMPAIGNS.forEach((spec, i) => {
    for (const phase of spec.phases) {
      for (let daysAgo = phase.fromDaysAgo; daysAgo >= phase.toDaysAgo; daysAgo--) {
        const day = addDays(config.today, -daysAgo);
        const spend = Math.round(phase.spendCents * (0.9 + 0.2 * rng()));
        const revenue = Math.round(spend * phase.roas * (0.85 + 0.3 * rng()));
        const impressions = Math.max(1, Math.round((spend / spec.cpmCents) * 1000));
        const clicks = Math.max(1, Math.round(impressions * spec.ctr * (0.85 + 0.3 * rng())));
        const conversions = Math.min(clicks, Math.round(revenue / AOV_CENTS));
        adSpend.push({
          id: uuidFrom(rng),
          shop_id: config.shopId,
          campaign_id: campaigns[i].id,
          day,
          spend_cents: spend,
          impressions,
          clicks,
          conversions,
          revenue_attrib_cents: revenue,
          polled_at: polledAt,
        });
      }
    }
  });

  // --- Attribution: ties orders to the campaign that plausibly drove them.
  // Hero-tee orders skew to the bleeder; west-region bottle orders to the
  // hydration push (which finds nothing once the region runs dry); pack
  // orders to the TikTok spark ads; the long tail splits across evergreens.
  const linesByOrderId = new Map<string, OrderLineRow[]>();
  for (const l of orderLines) {
    const arr = linesByOrderId.get(l.order_id) ?? [];
    arr.push(l);
    linesByOrderId.set(l.order_id, arr);
  }

  // Ship cost allocation — reuses linesByOrderId built just above.
  for (const order of orders) {
    const lines = linesByOrderId.get(order.id) ?? [];
    const totalQty = lines.reduce((s, l) => s + l.quantity, 0);
    // defensive: generated orders always have ≥1 line
    if (totalQty === 0) continue;
    const orderShipCost = 425 + Math.max(0, totalQty - 1) * 75;
    const day = order.created_at_source.slice(0, 10);
    for (const l of lines) {
      const skuShare = l.quantity / totalQty;
      // seed-only: per-line rounding may not sum exactly to the order's ship cost; the live resolver (split.ts) uses largest-remainder to stay exact.
      const skuShipCost = Math.round(orderShipCost * skuShare);
      const key = `${l.sku_id}|${day}`;
      shipCostBySkuDay.set(key, (shipCostBySkuDay.get(key) ?? 0) + skuShipCost);
    }
  }

  const specByKey = new Map(CAMPAIGNS.map((spec) => [spec.key, spec]));
  const slugOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const UTM_SOURCE = { meta: "facebook", google: "google", tiktok: "tiktok" } as const;
  const UTM_MEDIUM = { meta: "paid_social", google: "cpc", tiktok: "paid_social" } as const;
  const attribution: AttributionRow[] = [];
  for (const order of orders) {
    const lines = linesByOrderId.get(order.id) ?? [];
    const day = order.created_at_source.slice(0, 10);
    const has = (skuId: string) => lines.some((l) => l.sku_id === skuId);
    const roll = rng();
    let key: CampaignSpec["key"] | null = null;
    if (has(scenario.heroTeeSkuId) && day >= addDays(config.today, -30)) {
      key = roll < 0.32 ? "metaBleeder" : roll < 0.5 ? "metaProspecting" : null;
    } else if (has(scenario.bottleSkuId)) {
      key =
        order.customer_region === "us-west" && day >= addDays(config.today, -45)
          ? (roll < 0.65 ? "googleHydrationWest" : null)
          : (roll < 0.2 ? "googlePmax" : roll < 0.35 ? "metaProspecting" : null);
    } else if (has(scenario.packSkuId) && day >= addDays(config.today, -44)) {
      key = roll < 0.6 ? "tiktokSpark" : null;
    } else if (has(scenario.duffelSkuId)) {
      key = roll < 0.3 ? "googlePmax" : roll < 0.5 ? "metaProspecting" : null;
    } else {
      key =
        roll < 0.16 ? "metaProspecting"
        : roll < 0.27 ? "metaRetargeting"
        : roll < 0.38 ? "googlePmax"
        : roll < 0.47 ? "googleBrand"
        : null;
    }
    if (!key) continue;
    const spec = specByKey.get(key)!;
    const methodRoll = rng();
    const method = methodRoll < 0.5 ? "utm_exact" : methodRoll < 0.8 ? "click_id" : "referrer_host";
    if (method === "utm_exact") {
      order.utm_source = UTM_SOURCE[spec.platform];
      order.utm_medium = UTM_MEDIUM[spec.platform];
      order.utm_campaign = slugOf(spec.name);
    }
    attribution.push({
      id: uuidFrom(rng),
      shop_id: config.shopId,
      order_id: order.id,
      campaign_id: campaignIdByKey.get(key)!,
      platform: spec.platform,
      attributed_revenue_cents: order.subtotal_cents - order.discount_cents,
      attribution_method: method,
      confidence: method === "utm_exact" ? "high" : method === "click_id" ? "strong" : "rough",
    });
  }

  // --- Merchant-confirmed creative→SKU maps: exactly one per platform, so the
  // platform-grain spend attribution the detectors use stays controlled.
  const confirmedAt = `${addDays(config.today, -14)}T12:00:00.000Z`;
  const creativeSkuMap: CreativeSkuMapRow[] = [
    { id: uuidFrom(rng), shop_id: config.shopId, platform: "meta", creative_id: "cr-meta-summit-ugc", creative_label: "Creator UGC — Summit Tee (@trailtwins)", sku_id: scenario.heroTeeSkuId, confidence: 0.95, source: "merchant_confirmed", confirmed_at: confirmedAt },
    { id: uuidFrom(rng), shop_id: config.shopId, platform: "google", creative_id: "cr-google-hydration", creative_label: "PMax asset group — Hydration Push", sku_id: scenario.bottleSkuId, confidence: 0.9, source: "merchant_confirmed", confirmed_at: confirmedAt },
    { id: uuidFrom(rng), shop_id: config.shopId, platform: "tiktok", creative_id: "cr-tiktok-crestline", creative_label: "Spark Ad — Crestline Pack UGC", sku_id: scenario.packSkuId, confidence: 0.9, source: "merchant_confirmed", confirmed_at: confirmedAt },
  ];

  // --- P&L: order-line revenue/COGS plus 60% of each platform's daily spend
  // allocated to its mapped SKU (the rest stays unattributed, as in real life).
  const mappedSkuIdByPlatform = new Map(creativeSkuMap.map((m) => [m.platform, m.sku_id]));
  const campaignById = new Map(campaigns.map((c) => [c.id, c]));
  const adAllocBySkuDay = new Map<string, number>();
  for (const s of adSpend) {
    const platform = campaignById.get(s.campaign_id)!.platform;
    const skuId = mappedSkuIdByPlatform.get(platform);
    if (!skuId) continue;
    const key = `${skuId}|${s.day}`;
    adAllocBySkuDay.set(key, (adAllocBySkuDay.get(key) ?? 0) + Math.round(s.spend_cents * 0.6));
  }
  const skuPnl: SkuPnlRow[] = [];
  for (const key of new Set([...pnlBySkuDay.keys(), ...adAllocBySkuDay.keys()])) {
    const [skuId, day] = key.split("|");
    const slot = pnlBySkuDay.get(key) ?? { revenue: 0, cogs: 0 };
    const returns = returnsBySkuDay.get(key) ?? 0;
    const adSpendAttrib = adAllocBySkuDay.get(key) ?? 0;
    const shipCost = shipCostBySkuDay.get(key) ?? 0;
    skuPnl.push({
      id: uuidFrom(rng),
      shop_id: config.shopId,
      sku_id: skuId,
      day,
      revenue_cents: slot.revenue,
      cogs_cents: slot.cogs,
      ad_spend_attrib_cents: adSpendAttrib,
      return_cents: returns,
      ship_cost_cents: shipCost,
      contribution_margin_cents: slot.revenue - slot.cogs - adSpendAttrib - returns - shipCost,
    });
  }

  // --- Engagement (meta + tiktok) and a 7d grade per campaign.
  const adEngagement: AdEngagementRow[] = [];
  for (const s of adSpend) {
    const camp = campaignById.get(s.campaign_id)!;
    if (camp.platform === "google") continue;
    if (daysBetween(s.day, config.today) > 30) continue;
    const reactions = Math.round(s.clicks * (0.5 + 0.6 * rng()));
    const comments = Math.round(s.clicks * 0.08 * rng());
    const shares = Math.round(s.clicks * 0.06 * rng());
    const saves = Math.round(s.clicks * 0.1 * rng());
    adEngagement.push({
      id: uuidFrom(rng),
      shop_id: config.shopId,
      campaign_id: camp.id,
      ad_external_id: `${camp.external_id}-ad-1`,
      ad_name: `${camp.name} — Ad 1`,
      day: s.day,
      impressions: s.impressions,
      link_clicks: s.clicks,
      reactions,
      comments,
      shares,
      saves,
      post_engagement: reactions + comments + shares + saves + s.clicks,
      polled_at: polledAt,
    });
  }

  const BREAK_EVEN_ROAS = 1.45;
  const campaignGrades: CampaignGradeRow[] = campaigns.map((camp) => {
    const cutoff = addDays(config.today, -6);
    const rows = adSpend.filter((s) => s.campaign_id === camp.id && s.day >= cutoff);
    const spend = rows.reduce((s, r) => s + r.spend_cents, 0);
    const revenue = rows.reduce((s, r) => s + r.revenue_attrib_cents, 0);
    const roas = spend > 0 ? revenue / spend : 0;
    const grade =
      roas >= BREAK_EVEN_ROAS * 2 ? "A"
      : roas >= BREAK_EVEN_ROAS * 1.3 ? "B"
      : roas >= BREAK_EVEN_ROAS ? "C"
      : roas >= BREAK_EVEN_ROAS * 0.6 ? "D"
      : "F";
    return {
      id: uuidFrom(rng),
      shop_id: config.shopId,
      campaign_id: camp.id,
      day_bucket: config.today,
      window_days: 7,
      grade,
      roas: Math.round(roas * 100) / 100,
      break_even_roas: BREAK_EVEN_ROAS,
      margin: 0.68,
      confidence: "high",
      spend_cents: spend,
      revenue_cents: revenue,
      cogs_cents: Math.round(revenue * 0.32),
      computed_at: polledAt,
    };
  });

  const computedAt = `${config.today}T12:00:00.000Z`;
  const skuVelocity: SkuVelocityRow[] = [];
  const stockoutForecasts: StockoutForecastRow[] = [];
  for (const sku of skus) {
    const units7 = sold7.get(sku.id) ?? 0;
    skuVelocity.push(
      { id: uuidFrom(rng), shop_id: config.shopId, sku_id: sku.id, window_days: 7, units: units7, computed_at: computedAt },
      { id: uuidFrom(rng), shop_id: config.shopId, sku_id: sku.id, window_days: 1, units: Math.round((units7 / 7) * 100) / 100, computed_at: computedAt },
    );
    const cover =
      sku.id === scenario.heroTeeSkuId ? 0
      : sku.id === scenario.hoodieLSkuId ? 6
      : sku.id === scenario.packSkuId ? 3.5
      : Math.round((21 + rng() * 14) * 10) / 10;
    stockoutForecasts.push({ id: uuidFrom(rng), shop_id: config.shopId, sku_id: sku.id, days_of_cover: cover, computed_at: computedAt });
  }

  return {
    locations,
    skus,
    orders,
    orderLines,
    fulfillments,
    refunds,
    campaigns,
    adSpend,
    attribution,
    creativeSkuMap,
    adEngagement,
    campaignGrades,
    inventoryLevels,
    cogsFacts,
    skuPnl,
    skuVelocity,
    stockoutForecasts,
    scenario,
    listPriceCentsBySkuId: Object.fromEntries(priceBySkuId),
  };
}

function locById(locations: LocationRow[], id: string): LocationRow {
  const loc = locations.find((l) => l.id === id);
  if (!loc) throw new Error(`unknown location ${id}`);
  return loc;
}
