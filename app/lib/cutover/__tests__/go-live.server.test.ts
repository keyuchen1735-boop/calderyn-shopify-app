import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkGoLiveGates, assertGoLiveGates } from "../go-live.server";
import { CutoverBlockedError } from "../errors";
import { CalderynError } from "~/lib/calderyn.server";
import type { DriftReport } from "../drift.server";

// getSupabase is replaced per-test via this holder so each test supplies its own stub.
let currentSb: unknown = null;
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => currentSb }));

// The value-parity gate rides checkDualRunDrift; mocked so gate tests control the
// verdict without a Shopify sweep. Defaults green (beforeEach) so the pre-existing
// assert tests keep proving the cheap checks on their own.
const driftMock = vi.fn();
vi.mock("../drift.server", () => ({
  checkDualRunDrift: (shopId: string) => driftMock(shopId) as Promise<DriftReport>,
}));

function greenDrift(overrides: Partial<DriftReport> = {}): DriftReport {
  return {
    variantsChecked: 3,
    pass: true,
    price: { count: 0, rows: [] },
    stock: { count: 0, rows: [] },
    shopifyOnly: { count: 0, sample: [] },
    ownedOnly: { count: 0, sample: [] },
    truncated: { count: 0, sample: [] },
    unmatchedLocations: 0,
    ...overrides,
  };
}

beforeEach(() => {
  driftMock.mockReset();
  driftMock.mockResolvedValue(greenDrift());
});

interface SbConfig {
  productAll: string[];
  productExt: string[];
  variantAll: string[];
  variantExt: string[];
  locationAll: string[];
  locationExt: string[];
  sku: string[];
  bridgeProduct: string[];
  bridgeVariant: string[];
  bridgeLocation: string[];
  tracked: string[];
  balances: string[];
  paidOrders: number;
  captures: number;
  /** shops.demo_mode for the value gate's demo exemption; defaults false. */
  demoMode?: boolean;
}

/**
 * Purpose-built Supabase stub for the gate queries. Each from(table) builder records
 * the selected column, eq filters, and whether .not(col,"is",null) narrowed it; the
 * thenable serves head-counts for orders/transaction_ledger and range()-sliced id
 * pages for everything else (mirroring PostgREST pagination).
 */
function makeSb(cfg: SbConfig) {
  const rowsFor = (
    table: string,
    column: string,
    notNulled: boolean,
    eqCols: Record<string, unknown>,
  ): string[] => {
    switch (table) {
      case "product_dim":
        return notNulled ? cfg.productExt : cfg.productAll;
      case "variant_dim":
        if (eqCols.inventory_tracked === true) return cfg.tracked;
        return notNulled ? cfg.variantExt : cfg.variantAll;
      case "location_dim":
        return notNulled ? cfg.locationExt : cfg.locationAll;
      case "sku_dim":
        return cfg.sku;
      case "import_map":
        if (eqCols.entity_type === "product") return cfg.bridgeProduct;
        if (eqCols.entity_type === "variant") return cfg.bridgeVariant;
        if (eqCols.entity_type === "location") return cfg.bridgeLocation;
        throw new Error("import_map query missing entity_type filter");
      case "inventory_balance":
        return cfg.balances;
      default:
        throw new Error(`unexpected id query on ${table}.${column}`);
    }
  };

  const builder = (table: string) => {
    let isCount = false;
    let column = "";
    let notNulled = false;
    let rangeFrom = 0;
    let rangeTo = Number.MAX_SAFE_INTEGER;
    const eqCols: Record<string, unknown> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test stub
    const b: any = {
      select: (cols: string, opts?: { count?: string; head?: boolean }) => {
        if (opts?.count) isCount = true;
        column = cols;
        return b;
      },
      eq: (col: string, val: unknown) => {
        eqCols[col] = val;
        return b;
      },
      not: () => {
        notNulled = true;
        return b;
      },
      order: () => b,
      range: (from: number, to: number) => {
        rangeFrom = from;
        rangeTo = to;
        return b;
      },
      maybeSingle: () =>
        Promise.resolve({
          data: table === "shops" ? { demo_mode: cfg.demoMode === true } : null,
          error: null,
        }),
      then: (res: (r: { data: unknown; count: number | null; error: null }) => unknown) => {
        if (isCount) {
          const n =
            table === "orders" && eqCols.state === "paid"
              ? cfg.paidOrders
              : table === "transaction_ledger" && eqCols.kind === "capture"
                ? cfg.captures
                : table === "import_map"
                  ? cfg.bridgeProduct.length + cfg.bridgeVariant.length + cfg.bridgeLocation.length
                  : 0;
          return res({ data: null, count: n, error: null });
        }
        const rows = rowsFor(table, column, notNulled, eqCols)
          .slice(rangeFrom, rangeTo + 1)
          .map((id) => ({ [column]: id }));
        return res({ data: rows, count: null, error: null });
      },
    };
    return b;
  };
  return { from: (table: string) => builder(table) };
}

/** A config where every gate check passes: 2 products / 3 variants / 1 location, all
 *  Shopify-originated and bridged, projection in sync, stock seeded, payment cleared. */
function allGreen(): SbConfig {
  return {
    productAll: ["p1", "p2"],
    productExt: ["p1", "p2"],
    variantAll: ["v1", "v2", "v3"],
    variantExt: ["v1", "v2", "v3"],
    locationAll: ["l1"],
    locationExt: ["l1"],
    sku: ["v1", "v2", "v3"],
    bridgeProduct: ["p1", "p2"],
    bridgeVariant: ["v1", "v2", "v3"],
    bridgeLocation: ["l1"],
    tracked: ["v1", "v2", "v3"],
    balances: ["v1", "v2", "v3"],
    paidOrders: 1,
    captures: 1,
  };
}

function checkByName(report: Awaited<ReturnType<typeof checkGoLiveGates>>, name: string) {
  const c = report.checks.find((x) => x.name === name);
  if (!c) throw new Error(`check ${name} missing from report`);
  return c;
}

describe("checkGoLiveGates", () => {
  it("passes with a fully bridged, seeded, payment-cleared shop", async () => {
    currentSb = makeSb(allGreen());
    const report = await checkGoLiveGates("shop-1");
    expect(report.pass).toBe(true);
    expect(report.checks).toHaveLength(9);
    for (const c of report.checks) expect(c.pass).toBe(true);
  });

  it("fails catalog_present on an empty store", async () => {
    const cfg = allGreen();
    cfg.productAll = [];
    cfg.productExt = [];
    cfg.variantAll = [];
    cfg.variantExt = [];
    cfg.sku = [];
    cfg.bridgeProduct = [];
    cfg.bridgeVariant = [];
    cfg.tracked = [];
    cfg.balances = [];
    currentSb = makeSb(cfg);
    const report = await checkGoLiveGates("shop-1");
    expect(report.pass).toBe(false);
    expect(checkByName(report, "catalog_present").pass).toBe(false);
  });

  it("fails variants_bridged when a Shopify variant has no bridge", async () => {
    const cfg = allGreen();
    cfg.bridgeVariant = ["v1", "v2"]; // v3 unlinked
    currentSb = makeSb(cfg);
    const report = await checkGoLiveGates("shop-1");
    expect(report.pass).toBe(false);
    const c = checkByName(report, "variants_bridged");
    expect(c.pass).toBe(false);
    expect(c.actual).toBe("1 unlinked, 0 stale links");
  });

  it("catches a +1/-1 count collision: one unlinked row + one stale bridge", async () => {
    const cfg = allGreen();
    // v3 lost its bridge; a stale bridge points at deleted variant v9. Counts match
    // (3 bridges, 3 shopify variants) — a count-only gate would pass. Ids must not.
    cfg.bridgeVariant = ["v1", "v2", "v9"];
    currentSb = makeSb(cfg);
    const report = await checkGoLiveGates("shop-1");
    expect(report.pass).toBe(false);
    const c = checkByName(report, "variants_bridged");
    expect(c.pass).toBe(false);
    expect(c.actual).toBe("1 unlinked, 1 stale links");
  });

  it("does not count owned-native rows against parity (external_id null)", async () => {
    const cfg = allGreen();
    // Merchant added 1 native product + 1 native variant during dual_run: full sets
    // grow, Shopify-originated sets and bridges stay in step -> bridging still passes.
    cfg.productAll = ["p1", "p2", "p3"];
    cfg.variantAll = ["v1", "v2", "v3", "v4"];
    cfg.sku = ["v1", "v2", "v3", "v4"]; // projection follows the full owned catalog
    cfg.tracked = ["v1", "v2", "v3", "v4"];
    cfg.balances = ["v1", "v2", "v3", "v4"];
    currentSb = makeSb(cfg);
    const report = await checkGoLiveGates("shop-1");
    expect(report.pass).toBe(true);
  });

  it("fails catalog_projection when sku_dim drifts from variant_dim", async () => {
    const cfg = allGreen();
    cfg.sku = ["v1", "v2"]; // v3 missing from analytics
    currentSb = makeSb(cfg);
    const report = await checkGoLiveGates("shop-1");
    expect(report.pass).toBe(false);
    const c = checkByName(report, "catalog_projection");
    expect(c.pass).toBe(false);
    expect(c.actual).toBe("1 missing from analytics, 0 extra in analytics");
  });

  it("fails inventory_seeded when a tracked variant has no balance row", async () => {
    const cfg = allGreen();
    cfg.balances = ["v1", "v2"];
    currentSb = makeSb(cfg);
    const report = await checkGoLiveGates("shop-1");
    expect(report.pass).toBe(false);
    const c = checkByName(report, "inventory_seeded");
    expect(c.pass).toBe(false);
    expect(c.actual).toBe("1 missing");
  });

  it("ignores untracked variants in the inventory check", async () => {
    const cfg = allGreen();
    cfg.tracked = ["v1"];
    cfg.balances = ["v1"];
    currentSb = makeSb(cfg);
    const report = await checkGoLiveGates("shop-1");
    expect(checkByName(report, "inventory_seeded").pass).toBe(true);
  });

  it("fails paid_order and captured_charge when no test transaction cleared", async () => {
    const cfg = allGreen();
    cfg.paidOrders = 0;
    cfg.captures = 0;
    currentSb = makeSb(cfg);
    const report = await checkGoLiveGates("shop-1");
    expect(report.pass).toBe(false);
    expect(checkByName(report, "paid_order").pass).toBe(false);
    expect(checkByName(report, "captured_charge").pass).toBe(false);
  });

  it("pages past 1000 rows instead of silently truncating", async () => {
    // 1500 tracked variants, all seeded and bridged: a query capped at the first 1000
    // rows would see phantom missing stock. The paged fetch must walk both pages.
    const many = Array.from({ length: 1500 }, (_, i) => `v${String(i).padStart(4, "0")}`);
    const cfg = allGreen();
    cfg.variantAll = many;
    cfg.variantExt = many;
    cfg.bridgeVariant = many;
    cfg.sku = many;
    cfg.tracked = many;
    cfg.balances = many;
    currentSb = makeSb(cfg);
    const report = await checkGoLiveGates("shop-1");
    expect(report.pass).toBe(true);
    expect(checkByName(report, "inventory_seeded").actual).toBe("0 missing");
  });

  it("throws when shopId is missing", async () => {
    await expect(checkGoLiveGates("")).rejects.toThrow(/shopId/);
  });
});

describe("assertGoLiveGates", () => {
  it("resolves when every check passes", async () => {
    currentSb = makeSb(allGreen());
    await expect(assertGoLiveGates("shop-1")).resolves.toBeUndefined();
  });

  it("throws a typed CutoverBlockedError naming every failing check", async () => {
    const cfg = allGreen();
    cfg.paidOrders = 0;
    cfg.sku = [];
    currentSb = makeSb(cfg);
    const err = await assertGoLiveGates("shop-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CutoverBlockedError);
    expect((err as Error).message).toMatch(
      /go-live blocked: 2 gate check\(s\) failing:.*catalog_projection.*paid_order/,
    );
  });
});

describe("assertGoLiveGates — value-parity (drift) gate", () => {
  it("runs the drift check with the shop id and resolves when values match", async () => {
    currentSb = makeSb(allGreen());
    await expect(assertGoLiveGates("shop-1")).resolves.toBeUndefined();
    expect(driftMock).toHaveBeenCalledWith("shop-1");
  });

  it("blocks when prices or stock diverge from live Shopify, naming the diff", async () => {
    currentSb = makeSb(allGreen());
    driftMock.mockResolvedValue(
      greenDrift({ pass: false, price: { count: 2, rows: [] }, stock: { count: 1, rows: [] } }),
    );
    const err = await assertGoLiveGates("shop-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CutoverBlockedError);
    expect((err as Error).message).toMatch(/values_match_shopify/);
    expect((err as Error).message).toMatch(/2 price/);
    expect((err as Error).message).toMatch(/1 stock/);
  });

  it("blocks when the sweep could not verify everything (truncated / unmatched)", async () => {
    currentSb = makeSb(allGreen());
    driftMock.mockResolvedValue(
      greenDrift({ pass: false, truncated: { count: 1, sample: ["P"] }, unmatchedLocations: 2 }),
    );
    const err = await assertGoLiveGates("shop-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CutoverBlockedError);
    expect((err as Error).message).toMatch(/1 unverifiable/);
    expect((err as Error).message).toMatch(/2 unmatched locations/);
  });

  it("passes a native shop with no Shopify side (not_connected, zero bridges)", async () => {
    // A truly native shop: owned catalog exists but nothing is Shopify-originated —
    // no external_ids, no import_map bridges. There is no Shopify side to diverge from.
    const cfg = allGreen();
    cfg.productExt = [];
    cfg.variantExt = [];
    cfg.locationExt = [];
    cfg.bridgeProduct = [];
    cfg.bridgeVariant = [];
    cfg.bridgeLocation = [];
    currentSb = makeSb(cfg);
    driftMock.mockRejectedValue(
      new CalderynError({ code: "not_connected", status: 409, message: "no Shopify side" }),
    );
    await expect(assertGoLiveGates("shop-1")).resolves.toBeUndefined();
  });

  it("fails CLOSED when a bridged (Shopify-heritage) shop reports not_connected", async () => {
    // allGreen HAS import_map bridges: this shop was imported from Shopify, so a
    // missing shop_domain is a data anomaly, not a native shop — values must not
    // skip verification.
    currentSb = makeSb(allGreen());
    driftMock.mockRejectedValue(
      new CalderynError({ code: "not_connected", status: 409, message: "no Shopify side" }),
    );
    const err = await assertGoLiveGates("shop-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CutoverBlockedError);
    expect((err as Error).message).toMatch(/values_match_shopify/);
    expect((err as Error).message).toMatch(/imported record link/);
  });

  it("fails CLOSED when Shopify is unreachable", async () => {
    currentSb = makeSb(allGreen());
    driftMock.mockRejectedValue(
      new CalderynError({ code: "shopify_unreachable", status: 502, message: "down" }),
    );
    const err = await assertGoLiveGates("shop-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CutoverBlockedError);
    expect((err as Error).message).toMatch(/could not reach Shopify/i);
  });

  it("skips the Shopify sweep when a cheap gate already fails", async () => {
    const cfg = allGreen();
    cfg.paidOrders = 0;
    currentSb = makeSb(cfg);
    await expect(assertGoLiveGates("shop-1")).rejects.toThrow(/go-live blocked/);
    expect(driftMock).not.toHaveBeenCalled();
  });

  it("rethrows an unexpected drift failure as a system error, not a gate block", async () => {
    currentSb = makeSb(allGreen());
    driftMock.mockRejectedValue(new Error("boom"));
    const err = await assertGoLiveGates("shop-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(CutoverBlockedError);
    expect((err as Error).message).toBe("boom");
  });

  it("passes a demo shop without sweeping Shopify (simulated values diverge by design)", async () => {
    // shops.demo_mode simulates action side effects, so owned values diverge from
    // Shopify on purpose (seeded synthetic variants always fail drift). The gate must
    // pass demo shops and never run the pointless Admin API sweep. Distinct shop id:
    // isShowcaseShop caches demo_mode per shop for the process lifetime, and "shop-1"
    // must stay cached as a real shop for the other gate tests.
    const cfg = allGreen();
    cfg.demoMode = true;
    currentSb = makeSb(cfg);
    driftMock.mockRejectedValue(new Error("sweep must not run for demo shops"));
    await expect(assertGoLiveGates("shop-demo")).resolves.toBeUndefined();
    expect(driftMock).not.toHaveBeenCalled();
  });
});
