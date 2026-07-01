// Dual-run drift report (platform pivot Step 9 follow-on). The go-live gates check
// id-level linkage; this module checks VALUES. During dual_run the owned source of
// truth (variant_dim.retail_price_cents, inventory_balance) can silently diverge from
// the real Shopify store when writes happen outside the mirrored executors (a price or
// stock edit made directly in Shopify admin: PRODUCTS_UPDATE webhooks are dropped by
// design since Slice 1, and inventory webhooks only feed the analytics stream). The
// mirror tables cannot answer this (inventory_level_fact mixes owned projections with
// Shopify observations, and no price mirror exists), so the check sweeps the live
// Shopify Admin API via the same fetchProducts pull the importer uses and diffs it
// against the owned tables through the import_map bridge.
//
// The sweep is synchronous and full-catalog (25 products per Admin API round trip):
// fine at pilot scale, but a multi-thousand-product shop will need a background run —
// revisit before onboarding one.
//
// The report is informational, not a gate: transitionOrgMode is untouched. Every count
// is exact for what the sweep can see; whatever it CANNOT see is itself counted —
// bridged variants missing from Shopify land in ownedOnly, and products whose variant
// or stock lists hit fetchProducts' single-page caps land in truncated — so nothing is
// silently skipped and `pass` never overstates coverage (rule 12).

import { CalderynError } from "~/lib/calderyn.server";
import { getSupabase } from "~/lib/supabase.server";
import { fetchProducts, type AdminProduct } from "~/lib/ingest/shopify-admin.server";
import { moneyToCents } from "~/lib/ingest/mappers.server";
import { buildSkuTitle } from "~/lib/sku-title";
import { pagedRows } from "./paged.server";

export interface DriftRow {
  /** Owned variant_dim.id. */
  variantId: string;
  /** Merchant-readable label (shared buildSkuTitle vocabulary) plus the sku. */
  label: string;
  /** Owned location_dim.id (stock rows only). */
  locationId?: string;
  /** Owned value: cents for price rows, units for stock rows. */
  owned: number;
  /** Live Shopify value, same unit. */
  shopify: number;
}

export interface DriftReport {
  variantsChecked: number;
  pass: boolean;
  price: { count: number; rows: DriftRow[] };
  stock: { count: number; rows: DriftRow[] };
  /** Active Shopify variants Calderyn cannot see (no bridge, or a bridge whose owned
   *  row is gone) — typically products created in Shopify after the import. */
  shopifyOnly: { count: number; sample: string[] };
  /** Bridged owned variants the Shopify sweep never returned — typically products
   *  deleted directly in Shopify admin during dual run. */
  ownedOnly: { count: number; sample: string[] };
  /** Products whose variant or stock lists hit fetchProducts' single-page caps
   *  (variants first:40, inventoryLevels first:20) and so could not be fully checked. */
  truncated: { count: number; sample: string[] };
  /** Shopify stock levels at locations with no bridge; counted, never compared. */
  unmatchedLocations: number;
}

const ROW_CAP = 50;
const SAMPLE_CAP = 10;

// fetchProducts page caps (see shopify-admin.server.ts): a list AT the cap may have
// been cut, so it counts as unverifiable rather than complete.
const VARIANTS_CAP = 40;
const LEVELS_CAP = 20;

interface VariantMeta {
  label: string;
  priceCents: number;
}

function pushCapped(rows: DriftRow[], row: DriftRow): void {
  if (rows.length < ROW_CAP) rows.push(row);
}

function pushSample(sample: string[], label: string): void {
  if (sample.length < SAMPLE_CAP) sample.push(label);
}

export async function checkDualRunDrift(shopId: string): Promise<DriftReport> {
  if (!shopId) throw new Error("shopId is required");
  const sb = getSupabase();

  const { data: shop, error: shopErr } = await sb
    .from("shops")
    .select("shop_domain")
    .eq("id", shopId)
    .single();
  if (shopErr) throw shopErr;
  const domain = (shop as { shop_domain: string | null }).shop_domain;
  // shop_domain is nullable since first-party auth: a native Calderyn shop has no
  // Shopify side to compare against — a permanent state, not a transient failure.
  if (!domain) {
    throw new CalderynError({
      code: "not_connected",
      status: 409,
      message: "This store is not connected to Shopify, so there is nothing to compare.",
    });
  }

  const [variantBridge, locationBridge, variants, balances] = await Promise.all([
    pagedRows(shopId, "import_map", "external_id, owned_id", ["external_id"], {
      eq: { entity_type: "variant" },
    }),
    pagedRows(shopId, "import_map", "external_id, owned_id", ["external_id"], {
      eq: { entity_type: "location" },
    }),
    // Product title rides the variant read as a PostgREST embed (no second sweep).
    pagedRows(
      shopId,
      "variant_dim",
      "id, sku, title, retail_price_cents, product:product_dim(title)",
      ["id"],
    ),
    pagedRows(shopId, "inventory_balance", "variant_id, location_id, on_hand, unavailable", [
      "variant_id",
      "location_id",
    ]),
  ]);

  const variantByExternal = new Map<string, string>();
  for (const r of variantBridge) variantByExternal.set(String(r.external_id), String(r.owned_id));
  const locationByExternal = new Map<string, string>();
  for (const r of locationBridge) locationByExternal.set(String(r.external_id), String(r.owned_id));

  const variantMeta = new Map<string, VariantMeta>();
  for (const r of variants) {
    // supabase-js infers a to-one embed as an array; PostgREST actually returns a
    // single object (same cast convention as project-sku-dim.server.ts).
    const embed = r.product as { title?: string } | Array<{ title?: string }> | null;
    const pTitle = (Array.isArray(embed) ? embed[0]?.title : embed?.title) ?? "";
    const sku = r.sku != null && r.sku !== "" ? ` (${String(r.sku)})` : "";
    variantMeta.set(String(r.id), {
      label: `${buildSkuTitle(pTitle, r.title == null ? null : String(r.title))}${sku}`,
      priceCents: r.retail_price_cents != null ? Number(r.retail_price_cents) : 0,
    });
  }

  // Owned sellable stock per (variant, location): on_hand minus unavailable, clamped
  // at 0 — the same projection the engine reads (projectLevelFact). A missing balance
  // row reads as 0 in the compare below.
  const sellable = new Map<string, number>();
  for (const r of balances) {
    sellable.set(
      `${String(r.variant_id)}:${String(r.location_id)}`,
      Math.max(0, Number(r.on_hand) - Number(r.unavailable)),
    );
  }

  const price: DriftRow[] = [];
  let priceCount = 0;
  const stock: DriftRow[] = [];
  let stockCount = 0;
  const shopifyOnlySample: string[] = [];
  let shopifyOnlyCount = 0;
  const truncatedSample: string[] = [];
  let truncatedCount = 0;
  let unmatchedLocations = 0;
  let variantsChecked = 0;
  const seenOwnedIds = new Set<string>();

  // Only the Shopify TRANSPORT is wrapped: a failing page fetch is expected and
  // merchant-actionable (502-shaped), while a bug in the compare logic below must
  // stay a real 500 and never masquerade as "Shopify unreachable".
  const iterator = fetchProducts(domain)[Symbol.asyncIterator]();
  for (;;) {
    let next: IteratorResult<AdminProduct>;
    try {
      next = await iterator.next();
    } catch (err) {
      console.warn("[cutover.drift] Shopify sweep failed", err);
      throw new CalderynError({
        code: "shopify_unreachable",
        status: 502,
        message: "Could not reach Shopify to compare values. Try again in a moment.",
      });
    }
    if (next.done) break;
    const product = next.value;
    const active = (product.status ?? "ACTIVE").toUpperCase() === "ACTIVE";

    let productTruncated = product.variants.nodes.length >= VARIANTS_CAP;
    for (const v of product.variants.nodes) {
      const ownedId = variantByExternal.get(v.id);
      const meta = ownedId ? variantMeta.get(ownedId) : undefined;
      if (!ownedId || !meta) {
        // Drafts and archived products cannot sell, so an unbridged one is noise,
        // not drift the merchant must fix before going live.
        if (active) {
          shopifyOnlyCount++;
          pushSample(shopifyOnlySample, `${product.title}${v.title ? `, ${v.title}` : ""}`);
        }
        continue;
      }
      seenOwnedIds.add(ownedId);
      variantsChecked++;

      if (v.price != null) {
        const shopifyCents = moneyToCents(v.price);
        if (shopifyCents !== meta.priceCents) {
          priceCount++;
          pushCapped(price, {
            variantId: ownedId,
            label: meta.label,
            owned: meta.priceCents,
            shopify: shopifyCents,
          });
        }
      }

      if (v.inventoryItem?.tracked) {
        const levels = v.inventoryItem.inventoryLevels.nodes;
        if (levels.length >= LEVELS_CAP) productTruncated = true;
        for (const lvl of levels) {
          const locId = locationByExternal.get(lvl.location.id);
          if (!locId) {
            unmatchedLocations++;
            continue;
          }
          const q = lvl.quantities.find((x) => x.name === "available");
          if (!q) continue;
          const owned = sellable.get(`${ownedId}:${locId}`) ?? 0;
          if (q.quantity !== owned) {
            stockCount++;
            pushCapped(stock, {
              variantId: ownedId,
              label: meta.label,
              locationId: locId,
              owned,
              shopify: q.quantity,
            });
          }
        }
      }
    }
    if (productTruncated) {
      truncatedCount++;
      pushSample(truncatedSample, product.title);
    }
  }

  // The reverse direction: a bridged owned variant the sweep never returned was
  // removed (or hidden) on the Shopify side — Calderyn still carries its price and
  // stock, which is exactly the divergence class this report exists to catch.
  const ownedOnlySample: string[] = [];
  let ownedOnlyCount = 0;
  for (const ownedId of new Set(variantByExternal.values())) {
    const meta = variantMeta.get(ownedId);
    if (meta && !seenOwnedIds.has(ownedId)) {
      ownedOnlyCount++;
      pushSample(ownedOnlySample, meta.label);
    }
  }

  return {
    variantsChecked,
    pass:
      priceCount === 0 &&
      stockCount === 0 &&
      shopifyOnlyCount === 0 &&
      ownedOnlyCount === 0 &&
      truncatedCount === 0 &&
      unmatchedLocations === 0,
    price: { count: priceCount, rows: price },
    stock: { count: stockCount, rows: stock },
    shopifyOnly: { count: shopifyOnlyCount, sample: shopifyOnlySample },
    ownedOnly: { count: ownedOnlyCount, sample: ownedOnlySample },
    truncated: { count: truncatedCount, sample: truncatedSample },
    unmatchedLocations,
  };
}
