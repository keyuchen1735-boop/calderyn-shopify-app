// app/lib/demo/showcase-seed.ts
//
// Pure generator for the demo-showcase layer that sits ON TOP of the Peak &
// Pine dataset (app/lib/seed/dataset.ts): the owned commerce spine the
// Customers/Orders screens read, an opening queue of engine-shaped alerts,
// a calibration baseline tuned for a live demo arc, audit history, and store
// branding. No I/O and no Date.now(); the reset orchestrator owns persistence.
//
// Alert rows deliberately reuse the engine's own shapes (entity_ref/evidence
// keys, day_bucket = anchor day) so the real engine's next scan upserts into
// the same (shop_id, detector_id, entity_ref, day_bucket) key instead of
// duplicating the queue.

import { mulberry32, seedFromString } from "../seed/rng";
import { uuidFrom, SANDBOX_CAMPAIGN_IDS } from "../seed/dataset";
import type { SeedDataset } from "../seed/dataset";

export interface ShowcaseConfig {
  shopId: string;
  /** Anchor day (YYYY-MM-DD); the dataset must be generated for the same day. */
  today: string;
  dataset: SeedDataset;
  rngSeed?: number;
}

type Row = Record<string, unknown>;

export interface ShowcaseLayer {
  buyers: Row[];
  buyerAddresses: Row[];
  buyerConsents: Row[];
  ownedOrders: Row[];
  ownedOrderLines: Row[];
  orderTransitions: Row[];
  alerts: Row[];
  alertContexts: Row[];
  pairCalibration: Row[];
  auditRows: Row[];
  storeSettings: Row;
  variantShipping: Row[];
  guardrailPatch: Row;
  shopPatch: Row;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Buyer identities: enough spread for VIP / repeat / new / at-risk / prospect
 * segments. Emails are plainly synthetic (never mailed). */
const PEOPLE: { name: string; city: string; region: string }[] = [
  { name: "Maya Patel", city: "Austin", region: "us-south" },
  { name: "Liam Nguyen", city: "Seattle", region: "us-west" },
  { name: "Sofia Garcia", city: "Denver", region: "us-central" },
  { name: "Noah Kim", city: "Chicago", region: "us-central" },
  { name: "Ava Johnson", city: "Boston", region: "us-east" },
  { name: "Ethan Brown", city: "Portland", region: "us-west" },
  { name: "Isla Martin", city: "Miami", region: "us-south" },
  { name: "Lucas Davis", city: "New York", region: "us-east" },
  { name: "Emma Wilson", city: "Brooklyn", region: "us-east" },
  { name: "Oliver Chen", city: "San Diego", region: "us-west" },
  { name: "Charlotte Lee", city: "Atlanta", region: "us-south" },
  { name: "Henry Walker", city: "Columbus", region: "us-central" },
  { name: "Amelia Hall", city: "Philadelphia", region: "us-east" },
  { name: "Jack Turner", city: "Phoenix", region: "us-west" },
  { name: "Harper Scott", city: "Nashville", region: "us-south" },
  { name: "Leo Rivera", city: "Minneapolis", region: "us-central" },
  { name: "Mila Adams", city: "Burlington", region: "us-east" },
  { name: "Owen Baker", city: "Boise", region: "us-west" },
  { name: "Ruby Flores", city: "Houston", region: "us-south" },
  { name: "Caleb Reed", city: "Detroit", region: "us-central" },
  { name: "Zoe Morgan", city: "Providence", region: "us-east" },
  { name: "Finn Cooper", city: "Sacramento", region: "us-west" },
  { name: "Nora Bell", city: "Charlotte", region: "us-south" },
  { name: "Eli Ward", city: "St. Louis", region: "us-central" },
  { name: "Ivy Bennett", city: "Albany", region: "us-east" },
  { name: "Miles Gray", city: "Tacoma", region: "us-west" },
  { name: "Lila James", city: "Savannah", region: "us-south" },
  { name: "Jonah Price", city: "Madison", region: "us-central" },
  { name: "Freya Ross", city: "Portland", region: "us-east" },
  { name: "Asher Long", city: "Reno", region: "us-west" },
  { name: "Poppy Hayes", city: "Birmingham", region: "us-south" },
  { name: "Silas Ford", city: "Des Moines", region: "us-central" },
];
const EMAIL_DOMAINS = ["gmail.com", "outlook.com", "yahoo.com", "icloud.com"];

function iso(dayMs: number): string {
  return new Date(dayMs).toISOString();
}

function emailFor(name: string, i: number): string {
  const [first, last] = name.toLowerCase().split(" ");
  return `${first}.${last}${i % 7 === 0 ? String(80 + i) : ""}@${EMAIL_DOMAINS[i % EMAIL_DOMAINS.length]}`;
}

export function generateShowcaseLayer(config: ShowcaseConfig): ShowcaseLayer {
  const { shopId, today, dataset } = config;
  const rng = mulberry32(config.rngSeed ?? seedFromString(`${shopId}:showcase`));
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  const nowIso = iso(todayMs + 14 * 60 * 60 * 1000); // 2pm on the anchor day

  // --- dataset lookups -----------------------------------------------------
  const skuByExternal = new Map(dataset.skus.map((s) => [s.external_id, s]));
  const sku = (handle: string, variant: string) => {
    const row = skuByExternal.get(`variant-${handle}-${variant}`);
    if (!row) throw new Error(`showcase seed: dataset missing variant-${handle}-${variant}`);
    return row;
  };
  const campaignByExternal = new Map(dataset.campaigns.map((c) => [c.external_id, c]));
  const campaign = (key: keyof typeof SANDBOX_CAMPAIGN_IDS) => {
    const row = campaignByExternal.get(SANDBOX_CAMPAIGN_IDS[key]);
    if (!row) throw new Error(`showcase seed: dataset missing campaign ${key}`);
    return row;
  };
  const locationByRegion = new Map(dataset.locations.map((l) => [l.region, l]));
  const location = (region: string) => {
    const row = locationByRegion.get(region);
    if (!row) throw new Error(`showcase seed: dataset missing location for ${region}`);
    return row;
  };

  const tee = sku("summit-logo-tee", "M");
  const hoodie = sku("ridgeline-hoodie", "L");
  const pack = sku("crestline-pack-28l", "one-size");
  const duffel = sku("basecamp-duffel-45l", "one-size");
  const windbreaker = sku("alpine-windbreaker", "S");
  const bottle = sku("basecamp-water-bottle", "one-size");
  const poles = sku("granite-trekking-poles", "one-size");
  const shell = sku("cascade-rain-shell", "M");

  // --- buyers + owned orders ----------------------------------------------
  const buyers: Row[] = PEOPLE.map((p, i) => ({
    id: uuidFrom(rng),
    shop_id: shopId,
    email_normalized: emailFor(p.name, i),
    phone: null,
    created_at: iso(todayMs - Math.floor(20 + rng() * 100) * DAY_MS),
  }));

  const buyerAddresses: Row[] = PEOPLE.map((p, i) => ({
    id: uuidFrom(rng),
    shop_id: shopId,
    buyer_id: buyers[i].id,
    kind: "shipping",
    name: p.name,
    line1: `${100 + Math.floor(rng() * 900)} ${["Cedar", "Summit", "Ridge", "Lake", "Pine"][i % 5]} St`,
    line2: null,
    city: p.city,
    region: p.region,
    postal: String(10000 + Math.floor(rng() * 89999)),
    country: "US",
    phone: null,
    is_default: true,
    created_at: buyers[i].created_at,
  }));

  const buyerConsents: Row[] = buyers
    .filter((_, i) => i % 5 !== 4) // ~80% marketing opt-in
    .map((b) => ({
      id: uuidFrom(rng),
      shop_id: shopId,
      buyer_id: b.id,
      policy: "marketing",
      version: "2026-06",
      accepted: true,
      source_ip: null,
      ua: null,
      captured_at: b.created_at,
    }));

  // Orders per buyer: buyer 0 is the VIP (large gear baskets), 1-6 are repeat
  // customers, the last four stay prospects (zero orders → "Prospect" segment).
  const ordersPerBuyer = (i: number): number => {
    if (i === 0) return 10;
    if (i <= 6) return 2 + Math.floor(rng() * 3);
    if (i >= PEOPLE.length - 4) return 0;
    return rng() < 0.35 ? 2 : 1;
  };

  const ownedOrders: Row[] = [];
  const ownedOrderLines: Row[] = [];
  const orderTransitions: Row[] = [];
  const catalogPool = dataset.skus;
  // The VIP buys from the high-ticket end so their lifetime spend clears $5k.
  const highTicketPool = catalogPool.filter((s) => s.retail_price_cents >= 8900);

  for (let i = 0; i < buyers.length; i++) {
    const n = ordersPerBuyer(i);
    for (let k = 0; k < n; k++) {
      const orderId = uuidFrom(rng);
      // Recency-biased age; the VIP's history reaches deeper so lifetime spend reads real.
      const maxAge = i === 0 ? 115 : 100;
      const ageDays = Math.floor(Math.pow(rng(), 1.5) * maxAge) + (k === 0 && i > 6 ? 1 : 0);
      // Always strictly before the anchor midnight so "today - created_at" ≥ 0.
      const createdMs = todayMs - ageDays * DAY_MS - (2 + Math.floor(rng() * 20)) * 60 * 60 * 1000;
      const lineCount = i === 0 ? 3 : 1 + Math.floor(rng() * 2);
      let subtotal = 0;
      for (let l = 0; l < lineCount; l++) {
        const pool = i === 0 ? highTicketPool : catalogPool;
        const pick = pool[Math.floor(rng() * pool.length)];
        const quantity = i === 0 ? 1 + Math.floor(rng() * 3) : 1;
        ownedOrderLines.push({
          id: uuidFrom(rng),
          shop_id: shopId,
          order_id: orderId,
          variant_id: pick.id,
          quantity,
          unit_price_cents: pick.retail_price_cents,
          title_snapshot: pick.title,
        });
        subtotal += pick.retail_price_cents * quantity;
      }
      const shipping = subtotal >= 10000 ? 0 : 795;
      const tax = Math.round(subtotal * 0.08);
      const refunded = rng() < 0.05;
      const recent = ageDays <= 1;
      const state = refunded ? "refunded" : recent ? "paid" : "fulfilled";
      ownedOrders.push({
        id: orderId,
        shop_id: shopId,
        buyer_id: buyers[i].id,
        state,
        subtotal_cents: subtotal,
        shipping_cents: shipping,
        tax_cents: tax,
        total_cents: subtotal + shipping + tax,
        currency: "usd",
        financial_status: refunded ? "refunded" : "paid",
        attribution: {},
        external_gid: null,
        source_version: null,
        created_at: iso(createdMs),
        confirmation_token: uuidFrom(rng).replace(/-/g, ""),
        channel: "storefront",
        protocol: null,
        client_id: null,
      });
      orderTransitions.push({
        id: uuidFrom(rng),
        shop_id: shopId,
        order_id: orderId,
        from_state: "checkout_pending",
        to_state: "paid",
        reason: "payment_confirmed",
        occurred_at: iso(createdMs),
      });
      if (state !== "paid") {
        orderTransitions.push({
          id: uuidFrom(rng),
          shop_id: shopId,
          order_id: orderId,
          from_state: "paid",
          to_state: state,
          reason: state === "refunded" ? "merchant_refund" : "fulfillment_complete",
          occurred_at: iso(createdMs + (1 + Math.floor(rng() * 2)) * DAY_MS),
        });
      }
    }
  }

  // --- alerts: the opening queue -------------------------------------------
  // Shapes mirror real engine output captured from the seeded showcase shops
  // (entity_ref/evidence keys + one-line narratives per detector).
  interface AlertSpec {
    detector: string;
    severity: string;
    impact: string;
    entityRef: Row;
    evidence: Row;
    narrative: string;
    rank: number;
    firstSeenDaysAgo: number;
    status?: "resolved";
    dayBucket?: string;
  }

  const bleeder = campaign("metaBleeder");
  const hydration = campaign("googleHydrationWest");
  const brand = campaign("googleBrand");
  const prospecting = campaign("metaProspecting");
  const capWinner = campaign("metaCapWinner");
  const dayAgo = (n: number) => new Date(todayMs - n * DAY_MS).toISOString().slice(0, 10);

  const specs: AlertSpec[] = [
    {
      detector: "sku_stockout_vs_spend", severity: "critical", impact: "4137.32",
      entityRef: { sku: tee.sku, sku_id: tee.id },
      evidence: { region: "us-east", sku_title: tee.title, campaign_id: bleeder.id, spend_7d_usd: "4137.32", unit_margin_usd: "-25.48", velocity_units_per_day: "8.14" },
      narrative: "Ads are running against a product with no inventory available.", rank: 3, firstSeenDaysAgo: 4,
    },
    {
      detector: "campaign_below_breakeven", severity: "high", impact: "868.48",
      entityRef: { platform: "meta", campaign_id: bleeder.id },
      evidence: { cogs_7d_usd: "0", spend_7d_usd: "868.48", campaign_name: bleeder.name, revenue_7d_usd: "0", gross_profit_7d_usd: "0" },
      narrative: "A campaign is costing more than it is bringing back in gross profit.", rank: 15, firstSeenDaysAgo: 3,
    },
    {
      detector: "ad_tax_overload", severity: "high", impact: "717.18",
      entityRef: { sku: tee.sku, sku_id: tee.id },
      evidence: { sku_id: tee.id, sku_title: tee.title, threshold: "0.40", ad_tax_ratio: "0.676", revenue_7d_usd: "2600.44", ad_spend_7d_usd: "1757.36" },
      narrative: "Ad cost is taking an outsized share of revenue right now.", rank: 16, firstSeenDaysAgo: 5,
    },
    {
      detector: "campaign_scaling_opportunity", severity: "medium", impact: "890.12",
      entityRef: { platform: "google", campaign_id: brand.id },
      evidence: { roas: "6.3701", grade: "winning", margin: "0.6875", increase_pct: 20, campaign_name: brand.name, daily_budget_usd: "35" },
      narrative: "A winning campaign has headroom to scale.", rank: 15, firstSeenDaysAgo: 2,
    },
    {
      detector: "campaign_scaling_opportunity", severity: "medium", impact: "3409.32",
      entityRef: { platform: "meta", campaign_id: prospecting.id },
      evidence: { roas: "9.0653", grade: "winning", margin: "0.6209", increase_pct: 20, campaign_name: prospecting.name, daily_budget_usd: "90" },
      narrative: "A winning campaign has headroom to scale.", rank: 15, firstSeenDaysAgo: 2,
    },
    {
      detector: "cogs_drift", severity: "high", impact: "1217.70",
      entityRef: { sku: duffel.sku, sku_id: duffel.id },
      evidence: { title: "Basecamp Duffel 45L", drift_pct: "0.300", units_30d: 99, prior_unit_cost_usd: "41.00", current_unit_cost_usd: "53.30" },
      narrative: "Unit cost has trended higher in the last month.", rank: 12, firstSeenDaysAgo: 6,
    },
    {
      detector: "margin_erosion", severity: "medium", impact: "520.30",
      entityRef: { sku: duffel.sku, sku_id: duffel.id },
      evidence: { title: "Basecamp Duffel 45L", drop_pct: "0.287", current_units_7d: 24, baseline_units_30d: 144, current_unit_margin_usd: "53.80", baseline_unit_margin_usd: "75.48" },
      narrative: "Margin has drifted below its recent baseline.", rank: 19, firstSeenDaysAgo: 6,
    },
    {
      detector: "negative_unit_economics", severity: "high", impact: "943.79",
      entityRef: { sku: bottle.sku, sku_id: bottle.id },
      evidence: { title: "Basecamp Water Bottle 750ml", units_14d: 36, cac_per_unit_usd: "42.72", net_per_unit_usd: "-26.22", gross_unit_margin_usd: "16.50" },
      narrative: "Acquisition cost is pushing the net per unit below zero.", rank: 14, firstSeenDaysAgo: 3,
    },
    {
      detector: "regional_shortage_risk", severity: "high", impact: "567.00",
      entityRef: { sku: tee.sku, region: "us-east", sku_id: tee.id },
      evidence: { title: tee.title, daily_demand: "1.8", lead_time_days: 14, shortfall_units: "25.2", regional_stock_units: 0 },
      narrative: "Regional demand is trending to outrun regional stock within lead time.", rank: 19, firstSeenDaysAgo: 1,
    },
    {
      detector: "regional_shortage_risk", severity: "medium", impact: "216.33",
      entityRef: { sku: poles.sku, region: "us-east", sku_id: poles.id },
      evidence: { title: "Granite Trekking Poles", daily_demand: "0.8", lead_time_days: 14, shortfall_units: "3.7", regional_stock_units: 8 },
      narrative: "Regional demand is trending to outrun regional stock within lead time.", rank: 19, firstSeenDaysAgo: 1,
    },
    {
      detector: "regional_spend_starved_stock", severity: "high", impact: "512.73",
      entityRef: { sku: bottle.sku, region: "us-west", sku_id: bottle.id },
      evidence: {
        region: "us-west", sku_title: "Basecamp Water Bottle 750ml", campaign_id: hydration.id,
        regional_stock: 0, to_location_id: location("us-west").external_id, stock_elsewhere: 179,
        from_location_id: location("us-east").external_id, inventory_item_id: bottle.inventory_item_id,
        recommended_delta: 67, regional_spend_7d_usd: "526.62", velocity_units_per_day: "9.71",
      },
      narrative: "Attention is concentrated in a region where local stock is missing.", rank: 26, firstSeenDaysAgo: 2,
    },
    {
      detector: "reorder_timing", severity: "high", impact: "950.86",
      entityRef: { sku: hoodie.sku, sku_id: hoodie.id },
      evidence: { title: hoodie.title, gap_days: "8.0", days_of_cover: "6.0", lead_time_days: 14, unit_margin_usd: "52.00", daily_velocity_units: "2.29" },
      narrative: "Lead time is longer than cover on hand and no order is open.", rank: 13, firstSeenDaysAgo: 1,
    },
    {
      detector: "reorder_timing", severity: "high", impact: "3276.00",
      entityRef: { sku: pack.sku, sku_id: pack.id },
      evidence: { title: "Crestline Pack 28L", gap_days: "10.5", days_of_cover: "3.5", lead_time_days: 14, unit_margin_usd: "91.00", daily_velocity_units: "3.43" },
      narrative: "Lead time is longer than cover on hand and no order is open.", rank: 13, firstSeenDaysAgo: 1,
    },
    {
      detector: "return_rate_hidden_loss", severity: "high", impact: "308.00",
      entityRef: { sku: windbreaker.sku, sku_id: windbreaker.id },
      evidence: { title: windbreaker.title, return_rate: "0.304", return_30d_usd: "903.00", units_sold_30d: 21, revenue_30d_usd: "2967.00" },
      narrative: "Returns are eating into what looks like healthy top-line volume.", rank: 21, firstSeenDaysAgo: 7,
    },
    {
      detector: "scaling_sku_fulfillment_risk", severity: "high", impact: "746.87",
      entityRef: { sku: pack.sku, sku_id: pack.id },
      evidence: { stock: 99, sku_title: "Crestline Pack 28L", days_of_cover: "3.5", spend_wow_ratio: "1.54", spend_prev_7d_usd: "385.07", spend_this_7d_usd: "591.37", velocity_units_per_day: "3.4300" },
      narrative: "A fast-growing product is running thin on cover.", rank: 17, firstSeenDaysAgo: 2,
    },
    {
      detector: "wrong_location_concentration", severity: "medium", impact: "4066.00",
      entityRef: { sku: shell.sku, region: "us-west", sku_id: shell.id, location_id: location("us-west").id },
      evidence: { title: shell.title, stock_units: 380, location_region: "us-west", demand_share_pct: "11.1", stock_concentration_pct: "92.7" },
      narrative: "Inventory is concentrated away from where the demand sits.", rank: 3, firstSeenDaysAgo: 1,
    },
    // Resolved history: what the audit page shows at demo start. Buckets sit in
    // the past so they never collide with the open queue's engine key.
    {
      detector: "campaign_scaling_opportunity", severity: "medium", impact: "412.60",
      entityRef: { platform: "meta", campaign_id: capWinner.id },
      evidence: { roas: "4.6012", grade: "winning", margin: "0.6786", increase_pct: 20, campaign_name: capWinner.name, daily_budget_usd: "30" },
      narrative: "A winning campaign has headroom to scale.", rank: 15,
      firstSeenDaysAgo: 4, status: "resolved", dayBucket: dayAgo(3),
    },
    {
      detector: "regional_shortage_risk", severity: "high", impact: "399.00",
      entityRef: { sku: tee.sku, region: "us-west", sku_id: tee.id },
      evidence: { title: tee.title, daily_demand: "1.3", lead_time_days: 14, shortfall_units: "17.7", regional_stock_units: 0 },
      narrative: "Regional demand is trending to outrun regional stock within lead time.", rank: 19,
      firstSeenDaysAgo: 3, status: "resolved", dayBucket: dayAgo(2),
    },
    {
      detector: "reorder_timing", severity: "high", impact: "1420.00",
      entityRef: { sku: duffel.sku, sku_id: duffel.id },
      evidence: { title: "Basecamp Duffel 45L", gap_days: "6.0", days_of_cover: "8.0", lead_time_days: 14, unit_margin_usd: "65.90", daily_velocity_units: "3.90" },
      narrative: "Lead time is longer than cover on hand and no order is open.", rank: 13,
      firstSeenDaysAgo: 6, status: "resolved", dayBucket: dayAgo(5),
    },
  ];

  const alerts: Row[] = [];
  const alertContexts: Row[] = [];
  for (const s of specs) {
    const id = uuidFrom(rng);
    const firstSeen = iso(todayMs - s.firstSeenDaysAgo * DAY_MS + 9 * 60 * 60 * 1000);
    const resolved = s.status === "resolved";
    alerts.push({
      id,
      shop_id: shopId,
      detector_id: s.detector,
      entity_ref: s.entityRef,
      status: resolved ? "resolved" : "open",
      severity: s.severity,
      dollar_impact: s.impact,
      day_bucket: s.dayBucket ?? today,
      claude_narrative: s.narrative,
      claude_rank: s.rank,
      first_seen_at: firstSeen,
      last_seen_at: resolved ? firstSeen : nowIso,
      resolved_at: resolved ? iso(todayMs - (s.firstSeenDaysAgo - 1) * DAY_MS) : null,
      snoozed_until: null,
    });
    alertContexts.push({
      alert_id: id,
      shop_id: shopId,
      evidence: s.evidence,
      created_at: firstSeen,
    });
  }
  // Resolved rows only: open alerts all share day_bucket = today, so a map
  // over every alert would collide keys and could silently hand an audit row
  // an OPEN alert.
  const resolvedByDetectorBucket = new Map(
    alerts.filter((a) => a.status === "resolved").map((a) => [`${a.detector_id}|${a.day_bucket}`, a]),
  );
  const resolvedAlert = (detector: string, bucket: string) => {
    const row = resolvedByDetectorBucket.get(`${detector}|${bucket}`);
    if (!row) throw new Error(`showcase seed: missing resolved alert ${detector}@${bucket}`);
    return row;
  };

  // --- audit history (linked to the resolved alerts above) ------------------
  const auditRows: Row[] = [
    {
      id: uuidFrom(rng),
      shop_id: shopId,
      alert_id: resolvedAlert("campaign_scaling_opportunity", dayAgo(3)).id,
      action_kind: "increase_campaign_budget",
      params: { region: null, platform: "meta", campaign_id: capWinner.id, external_id: capWinner.external_id, daily_budget_cents: 3600 },
      outcome: "succeeded",
      pre_state: { daily_budget_cents: 3000 },
      post_state: { daily_budget_cents: 3600 },
      attempts: 0,
      actor_user_id: "merchant:web-dashboard",
      actor_is_super_admin: false,
      dollar_impact_at_exec: 412.6,
      trigger_reason: null,
      created_at: iso(todayMs - 3 * DAY_MS + 15 * 60 * 60 * 1000),
      completed_at: iso(todayMs - 3 * DAY_MS + 15 * 60 * 60 * 1000),
    },
    {
      id: uuidFrom(rng),
      shop_id: shopId,
      alert_id: resolvedAlert("regional_shortage_risk", dayAgo(2)).id,
      action_kind: "reallocate_inventory",
      params: { sku_id: tee.id, units: 40, from_location_id: location("us-central").external_id, to_location_id: location("us-west").external_id },
      outcome: "succeeded",
      pre_state: { from_available: 96, to_available: 0 },
      post_state: { from_available: 56, to_available: 40 },
      attempts: 0,
      actor_user_id: "autopilot",
      actor_is_super_admin: false,
      dollar_impact_at_exec: 399,
      trigger_reason: "graduated_pair",
      created_at: iso(todayMs - 2 * DAY_MS + 11 * 60 * 60 * 1000),
      completed_at: iso(todayMs - 2 * DAY_MS + 11 * 60 * 60 * 1000),
    },
    {
      id: uuidFrom(rng),
      shop_id: shopId,
      alert_id: resolvedAlert("reorder_timing", dayAgo(5)).id,
      action_kind: "create_po_draft",
      params: { sku_id: duffel.id, quantity: 120, unit_cost_cents: 5330 },
      outcome: "succeeded",
      pre_state: { days_of_cover: 8 },
      post_state: { po_units: 120 },
      attempts: 0,
      actor_user_id: "merchant:web-dashboard",
      actor_is_super_admin: false,
      dollar_impact_at_exec: 1420,
      trigger_reason: null,
      created_at: iso(todayMs - 5 * DAY_MS + 16 * 60 * 60 * 1000),
      completed_at: iso(todayMs - 5 * DAY_MS + 16 * 60 * 60 * 1000),
    },
  ];

  // --- calibration baseline --------------------------------------------------
  // Two pairs are already autopilot-ready (flip the switch mid-demo and they
  // act); two sit close enough that a couple of live approvals move the needle.
  const pair = (
    detector: string,
    action: string,
    alpha: number,
    beta: number,
    extras: Row,
  ): Row => ({
    shop_id: shopId,
    detector_id: detector,
    action_kind: action,
    alpha,
    beta,
    clean_approvals: alpha,
    consecutive_clean_approvals: Math.min(alpha, 9),
    consecutive_undos: 0,
    graduation_threshold: 75,
    merchant_disabled: false,
    graduated: false,
    autonomy_enabled: false,
    last_conf: null,
    last_detection: nowIso,
    net_positive_outcomes: 0,
    last_outcome_sign: null,
    updated_at: nowIso,
    ...extras,
  });

  const pairCalibration: Row[] = [
    pair("sku_stockout_vs_spend", "pause_campaign", 14, 1, {
      graduated: true, autonomy_enabled: true, net_positive_outcomes: 4, last_outcome_sign: 1, last_conf: 0.93,
    }),
    pair("campaign_below_breakeven", "pause_campaign", 11, 1, {
      graduated: true, autonomy_enabled: true, net_positive_outcomes: 3, last_outcome_sign: 1, last_conf: 0.9,
    }),
    pair("campaign_scaling_opportunity", "increase_campaign_budget", 19, 2, {
      net_positive_outcomes: 2, last_outcome_sign: 1, last_conf: 0.86,
    }),
    pair("reorder_timing", "create_po_draft", 8, 1, { net_positive_outcomes: 1, last_conf: 0.78 }),
    pair("regional_shortage_risk", "reallocate_inventory", 6, 2, { net_positive_outcomes: 1, last_conf: 0.71 }),
    pair("margin_erosion", "adjust_price", 3, 1, { last_conf: 0.62 }),
  ];

  // --- storefront + config ---------------------------------------------------
  const storeSettings: Row = {
    shop_id: shopId,
    store_name: "Peak & Pine Outfitters",
    palette: { primary: "#1f3d2b", background: "#faf8f4", text: "#17201a" },
    logo_url: null,
    voice_tagline: "Built for the long trail.",
    updated_at: nowIso,
  };

  const variantShipping: Row[] = dataset.skus.map((s) => ({
    variant_id: s.id,
    shop_id: shopId,
    weight_grams: s.grams,
    length_mm: null,
    width_mm: null,
    height_mm: null,
    requires_shipping: true,
    restricted_countries: [],
    handling_days: 2,
    signature_required: false,
    updated_at: nowIso,
  }));

  return {
    buyers,
    buyerAddresses,
    buyerConsents,
    ownedOrders,
    ownedOrderLines,
    orderTransitions,
    alerts,
    alertContexts,
    pairCalibration,
    auditRows,
    storeSettings,
    variantShipping,
    guardrailPatch: { autopilot_enabled: false, autopilot_bypass_guardrails: false },
    // org_mode 'live' + completed onboarding are demo-shop invariants: owned
    // writes must stay authoritative even if someone toured the Go live screen
    // mid-demo, and the demo never replays the onboarding stepper.
    shopPatch: {
      calibration_pct: null,
      calibration_updated_at: null,
      org_mode: "live",
      onboarding_step: "complete",
    },
  };
}
