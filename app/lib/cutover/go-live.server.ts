// Go-live gates (platform pivot Step 9, slice 3). The hard gates the spec puts in
// front of dual_run -> live: the PARITY gate (everything the mirror holds made it into
// the owned source-of-truth tables, bridged through import_map — an ID-LEVEL set diff,
// not a count comparison: a missing bridge and a stale bridge can cancel out in a
// count, so each check names how many rows are unlinked and how many links point at
// nothing), the VALUE-PARITY gate (prices and stock must match the live Shopify store,
// verified by the dual-run drift sweep — the divergence axis id-level linkage cannot
// see), and the PAYMENT-CLEARED gate (a real test transaction reached `paid` with a
// captured Stripe charge). The report is honest by construction — every check states
// what was expected and what was found, so a failing gate tells the merchant exactly
// what to fix (rule 12: fail visibly).
//
// transitionOrgMode calls assertGoLiveGates for every `-> live` move, so the gates
// cannot be bypassed from any surface (dashboard, API, script).

import { CalderynError } from "~/lib/calderyn.server";
import { getSupabase } from "~/lib/supabase.server";
import { isShowcaseShop } from "~/lib/demo/showcase.server";
import { pagedRows, type PagedFilter } from "./paged.server";
import { checkDualRunDrift } from "./drift.server";
import { CutoverBlockedError } from "./errors";

export interface GateCheck {
  /** Stable machine id, e.g. "variants_bridged". */
  name: string;
  /** Plain-language merchant copy for the dashboard checklist. */
  label: string;
  expected: string;
  actual: string;
  pass: boolean;
}

export interface GoLiveReport {
  pass: boolean;
  checks: GateCheck[];
}

/** Page through `select column from table where shop_id = ...` (shared pagedRows,
 *  one PostgREST-truncation backstop for all cutover reads) and return the distinct
 *  values as a Set. */
async function pagedIds(
  shopId: string,
  table: string,
  column: string,
  filter?: PagedFilter,
): Promise<Set<string>> {
  const rows = await pagedRows(shopId, table, column, [column], filter);
  const ids = new Set<string>();
  for (const row of rows) {
    const v = row[column];
    if (v != null) ids.add(String(v));
  }
  return ids;
}

/** Exact head-count of rows in `table` matching the eq filters. */
async function countRows(
  shopId: string,
  table: string,
  eq: Record<string, string>,
): Promise<number> {
  const sb = getSupabase();
  let q = sb.from(table).select("id", { count: "exact", head: true }).eq("shop_id", shopId);
  for (const [col, val] of Object.entries(eq)) q = q.eq(col, val);
  const { count, error } = await q;
  if (error) throw error;
  return count ?? 0;
}

/** How many members of `a` are not in `b`. */
function missingFrom(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const v of a) if (!b.has(v)) n++;
  return n;
}

function check(
  name: string,
  label: string,
  expected: string,
  actual: string,
  pass: boolean,
): GateCheck {
  return { name, label, expected, actual, pass };
}

/** One per-entity parity check: every Shopify-originated owned row has a bridge AND
 *  every bridge points at a row that still exists. Id-level both ways. */
function bridgeCheck(
  name: string,
  label: string,
  shopifyOwnedIds: Set<string>,
  bridgedOwnedIds: Set<string>,
): GateCheck {
  const unlinked = missingFrom(shopifyOwnedIds, bridgedOwnedIds);
  const stale = missingFrom(bridgedOwnedIds, shopifyOwnedIds);
  return check(
    name,
    label,
    "0 unlinked, 0 stale links",
    `${unlinked} unlinked, ${stale} stale links`,
    unlinked === 0 && stale === 0,
  );
}

/**
 * Run every go-live check and return the full report (never throws on a failing
 * check — throwing is assertGoLiveGates' job). Parity covers Shopify-originated
 * owned rows (external_id present), so products/variants/locations the merchant
 * creates natively in Calderyn during dual_run don't block the gate.
 */
export async function checkGoLiveGates(shopId: string): Promise<GoLiveReport> {
  if (!shopId) throw new Error("shopId is required");

  const [
    productIds,
    productShopifyIds,
    variantIds,
    variantShopifyIds,
    locationIds,
    locationShopifyIds,
    skuIds,
    bridgedProductIds,
    bridgedVariantIds,
    bridgedLocationIds,
    trackedIds,
    balanceVariantIds,
    paidOrders,
    capturedCharges,
  ] = await Promise.all([
    pagedIds(shopId, "product_dim", "id"),
    pagedIds(shopId, "product_dim", "id", { notNull: "external_id" }),
    pagedIds(shopId, "variant_dim", "id"),
    pagedIds(shopId, "variant_dim", "id", { notNull: "external_id" }),
    pagedIds(shopId, "location_dim", "id"),
    pagedIds(shopId, "location_dim", "id", { notNull: "external_id" }),
    pagedIds(shopId, "sku_dim", "id"),
    pagedIds(shopId, "import_map", "owned_id", { eq: { entity_type: "product" } }),
    pagedIds(shopId, "import_map", "owned_id", { eq: { entity_type: "variant" } }),
    pagedIds(shopId, "import_map", "owned_id", { eq: { entity_type: "location" } }),
    pagedIds(shopId, "variant_dim", "id", { eq: { inventory_tracked: true } }),
    pagedIds(shopId, "inventory_balance", "variant_id"),
    countRows(shopId, "orders", { state: "paid" }),
    countRows(shopId, "transaction_ledger", { kind: "capture" }),
  ]);

  const stockMissing = missingFrom(trackedIds, balanceVariantIds);
  const skuOnly = missingFrom(skuIds, variantIds);
  const variantOnly = missingFrom(variantIds, skuIds);

  const checks: GateCheck[] = [
    // --- catalog present: an empty store must never go live -----------------
    check(
      "catalog_present",
      "Your store has products",
      "at least 1 product with at least 1 variant",
      `${productIds.size} products, ${variantIds.size} variants`,
      productIds.size > 0 && variantIds.size > 0,
    ),
    check(
      "location_present",
      "Your store has a stock location",
      "at least 1 location",
      `${locationIds.size} locations`,
      locationIds.size > 0,
    ),

    // --- parity: id-level bridge diff for every Shopify-originated row ------
    bridgeCheck(
      "products_bridged",
      "Every imported product is linked to its Shopify original",
      productShopifyIds,
      bridgedProductIds,
    ),
    bridgeCheck(
      "variants_bridged",
      "Every imported variant is linked to its Shopify original",
      variantShopifyIds,
      bridgedVariantIds,
    ),
    bridgeCheck(
      "locations_bridged",
      "Every imported location is linked to its Shopify original",
      locationShopifyIds,
      bridgedLocationIds,
    ),

    // --- projection parity: the analytics catalog mirrors the owned catalog --
    check(
      "catalog_projection",
      "Your analytics catalog matches your live catalog",
      "0 out of sync",
      `${variantOnly} missing from analytics, ${skuOnly} extra in analytics`,
      skuOnly === 0 && variantOnly === 0,
    ),

    // --- inventory: every stock-tracked variant has a stock record ----------
    check(
      "inventory_seeded",
      "Every stock-tracked product has a stock record",
      "0 missing",
      `${stockMissing} missing`,
      stockMissing === 0,
    ),

    // --- payment-cleared: a test transaction actually cleared ---------------
    check(
      "paid_order",
      "A test order was paid on Calderyn checkout",
      "at least 1 paid order",
      `${paidOrders} paid orders`,
      paidOrders >= 1,
    ),
    check(
      "captured_charge",
      "The test payment was captured by Stripe",
      "at least 1 captured charge",
      `${capturedCharges} captured charges`,
      capturedCharges >= 1,
    ),
  ];

  return { pass: checks.every((c) => c.pass), checks };
}

const VALUES_LABEL = "Your prices and stock match your live Shopify store";

/**
 * Value-parity gate: prices and stock must MATCH the live Shopify store, verified by
 * the dual-run drift sweep (checkDualRunDrift) — the id-level bridge checks cannot see
 * a price edited directly in Shopify admin during dual_run. Outcomes beyond a clean
 * diff: a demo shop (shops.demo_mode) PASSES without sweeping — it simulates action
 * side effects by design, so its owned values diverge from Shopify on purpose and its
 * seeded synthetic variants would fail drift forever; a truly native shop (no Shopify
 * side AND no import_map heritage) PASSES — a permanent state with nothing to diverge
 * from, not a failure; an unreachable Shopify FAILS CLOSED (unverifiable parity must
 * block a go-live, never wave it through); any other failure is a real system fault
 * and propagates as one, never masquerading as a gate verdict.
 */
async function checkValuesGate(shopId: string): Promise<GateCheck> {
  // Shared demo_mode lookup (process-cached; fails safe toward "real shop", so a
  // transient lookup error can never exempt a real merchant from the sweep).
  if (await isShowcaseShop(shopId)) {
    return check(
      "values_match_shopify",
      VALUES_LABEL,
      "0 differences",
      "demo store; values are simulated and not compared against Shopify",
      true,
    );
  }

  try {
    const drift = await checkDualRunDrift(shopId);
    return check(
      "values_match_shopify",
      VALUES_LABEL,
      "0 differences",
      `${drift.price.count} price, ${drift.stock.count} stock, ` +
        `${drift.shopifyOnly.count} only in Shopify, ${drift.ownedOnly.count} only in Calderyn, ` +
        `${drift.truncated.count} unverifiable, ${drift.unmatchedLocations} unmatched locations`,
      drift.pass,
    );
  } catch (err) {
    if (err instanceof CalderynError && err.code === "not_connected") {
      // Only a shop with NO Shopify heritage may skip the value sweep. A shop that
      // holds import_map bridges was imported FROM Shopify, so a missing shop_domain
      // is a data anomaly, not a native shop — waving it through would skip value
      // verification exactly where it matters most. Fail closed instead (rule 12).
      const bridged = await countRows(shopId, "import_map", {});
      if (bridged > 0) {
        return check(
          "values_match_shopify",
          VALUES_LABEL,
          "0 differences",
          `not connected to Shopify but ${bridged} imported record link(s) exist; reconnect Shopify to verify values`,
          false,
        );
      }
      return check(
        "values_match_shopify",
        VALUES_LABEL,
        "0 differences",
        "not connected to Shopify; nothing to compare",
        true,
      );
    }
    if (err instanceof CalderynError && err.code === "shopify_unreachable") {
      return check(
        "values_match_shopify",
        VALUES_LABEL,
        "0 differences",
        "could not reach Shopify to verify values",
        false,
      );
    }
    throw err;
  }
}

/**
 * The hard gate: throws CutoverBlockedError (listing every failing check) unless ALL
 * go-live checks pass. Called by transitionOrgMode on any `-> live` move — the single
 * choke point, so no caller can flip a shop live past a failing parity, value-parity,
 * or payment gate (rule 12). The typed error lets the API layer answer 409 for a
 * blocked move while a genuine system failure still surfaces as a 500.
 *
 * The value-parity sweep is network-bound and full-catalog, so it only runs once the
 * cheap structural checks are all green — a structurally-blocked retry never touches
 * the Shopify Admin API. (A value-blocked retry does re-run the sweep: it is an
 * operator-triggered action at white-glove pilot scale, the same cost as the drift
 * panel's "Compare with Shopify" button.)
 */
export async function assertGoLiveGates(shopId: string): Promise<void> {
  const report = await checkGoLiveGates(shopId);
  const checks = report.pass ? [...report.checks, await checkValuesGate(shopId)] : report.checks;
  const failing = checks.filter((c) => c.pass === false);
  if (failing.length === 0) return;
  const detail = failing
    .map((c) => `${c.name} (expected ${c.expected}, found ${c.actual})`)
    .join("; ");
  throw new CutoverBlockedError(
    `go-live blocked: ${failing.length} gate check(s) failing: ${detail}`,
  );
}
