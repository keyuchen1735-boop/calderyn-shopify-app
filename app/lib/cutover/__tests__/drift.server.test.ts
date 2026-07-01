import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkDualRunDrift } from "../drift.server";
import { CalderynError } from "~/lib/calderyn.server";
import { buildSkuTitle } from "~/lib/sku-title";

// getSupabase is replaced per-test via this holder so each test supplies its own stub.
let currentSb: unknown = null;
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => currentSb }));

// fetchProducts is replaced per-test: either a fixture array served as an async
// generator, or a custom impl (to simulate Shopify being unreachable).
let shopifyProducts: unknown[] = [];
let fetchImpl: (() => AsyncGenerator<unknown>) | null = null;
vi.mock("~/lib/ingest/shopify-admin.server", () => ({
  fetchProducts: () => {
    if (fetchImpl) return fetchImpl();
    return (async function* () {
      for (const p of shopifyProducts) yield p;
    })();
  },
}));

type Row = Record<string, unknown>;

/**
 * Minimal Supabase stub: each from(table) builder applies eq filters against the
 * fixture rows and serves range()-sliced pages (mirroring PostgREST pagination)
 * plus single() for the shop-domain lookup.
 */
function makeSb(tables: Record<string, Row[]>) {
  const builder = (table: string) => {
    const eqCols: Record<string, unknown> = {};
    let rangeFrom = 0;
    let rangeTo = Number.MAX_SAFE_INTEGER;
    const filt = () =>
      (tables[table] ?? []).filter((r) =>
        Object.entries(eqCols).every(([c, v]) => r[c] === v),
      );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test stub
    const b: any = {
      select: () => b,
      eq: (col: string, val: unknown) => {
        eqCols[col] = val;
        return b;
      },
      not: () => b,
      order: () => b,
      range: (from: number, to: number) => {
        rangeFrom = from;
        rangeTo = to;
        return b;
      },
      single: () => {
        const rows = filt();
        return Promise.resolve(
          rows.length
            ? { data: rows[0], error: null }
            : { data: null, error: new Error(`${table}: no row`) },
        );
      },
      then: (res: (r: { data: unknown; error: null }) => unknown) =>
        res({ data: filt().slice(rangeFrom, rangeTo + 1), error: null }),
    };
    return b;
  };
  return { from: builder };
}

const SHOP = "shop1";
const V_GID = "gid://shopify/ProductVariant/1";
const L_GID = "gid://shopify/Location/9";
const LABEL = `${buildSkuTitle("Tee", "Small")} (SKU1)`;

/** Baseline fixtures: one bridged variant at one bridged location, price and stock in sync. */
function baseTables(): Record<string, Row[]> {
  return {
    shops: [{ id: SHOP, shop_domain: "t.myshopify.com" }],
    import_map: [
      { shop_id: SHOP, entity_type: "variant", external_id: V_GID, owned_id: "v1" },
      { shop_id: SHOP, entity_type: "location", external_id: L_GID, owned_id: "l1" },
    ],
    variant_dim: [
      {
        shop_id: SHOP,
        id: "v1",
        sku: "SKU1",
        title: "Small",
        retail_price_cents: 1000,
        product: { title: "Tee" },
      },
    ],
    inventory_balance: [
      { shop_id: SHOP, variant_id: "v1", location_id: "l1", on_hand: 5, unavailable: 1 },
    ],
  };
}

interface ShopifyVariantOpts {
  gid?: string;
  price?: string | null;
  tracked?: boolean;
  levels?: Array<{ locationGid: string; available: number }>;
}

function shopifyProduct(title: string, variants: ShopifyVariantOpts[], status = "ACTIVE") {
  return {
    id: "gid://shopify/Product/10",
    title,
    status,
    vendor: null,
    productType: null,
    tags: [],
    collections: { nodes: [] },
    variants: {
      nodes: variants.map((v, i) => ({
        id: v.gid ?? V_GID,
        sku: `SKU${i + 1}`,
        title: "Small",
        price: v.price === undefined ? "10.00" : v.price,
        inventoryPolicy: "DENY",
        inventoryItem: {
          id: `ii${i + 1}`,
          tracked: v.tracked ?? true,
          unitCost: null,
          inventoryLevels: {
            nodes: (v.levels ?? [{ locationGid: L_GID, available: 4 }]).map((l) => ({
              location: { id: l.locationGid },
              quantities: [{ name: "available", quantity: l.available }],
            })),
          },
        },
      })),
    },
  };
}

beforeEach(() => {
  currentSb = makeSb(baseTables());
  shopifyProducts = [shopifyProduct("Tee", [{}])];
  fetchImpl = null;
});

describe("checkDualRunDrift", () => {
  it("passes when price and stock match on every bridged variant", async () => {
    const report = await checkDualRunDrift(SHOP);
    expect(report.pass).toBe(true);
    expect(report.variantsChecked).toBe(1);
    expect(report.price.count).toBe(0);
    expect(report.stock.count).toBe(0);
    expect(report.shopifyOnly.count).toBe(0);
    expect(report.ownedOnly.count).toBe(0);
    expect(report.truncated.count).toBe(0);
    expect(report.unmatchedLocations).toBe(0);
  });

  it("reports a price mismatch with both values in cents", async () => {
    shopifyProducts = [shopifyProduct("Tee", [{ price: "12.00" }])];
    const report = await checkDualRunDrift(SHOP);
    expect(report.pass).toBe(false);
    expect(report.price.count).toBe(1);
    expect(report.price.rows[0]).toMatchObject({
      variantId: "v1",
      label: LABEL,
      owned: 1000,
      shopify: 1200,
    });
  });

  it("treats a null owned price as 0 cents", async () => {
    const tables = baseTables();
    tables.variant_dim[0].retail_price_cents = null;
    currentSb = makeSb(tables);
    const report = await checkDualRunDrift(SHOP);
    expect(report.price.count).toBe(1);
    expect(report.price.rows[0]).toMatchObject({ owned: 0, shopify: 1000 });
  });

  it("reports a stock mismatch against owned sellable (on_hand - unavailable)", async () => {
    shopifyProducts = [shopifyProduct("Tee", [{ levels: [{ locationGid: L_GID, available: 7 }] }])];
    const report = await checkDualRunDrift(SHOP);
    expect(report.stock.count).toBe(1);
    expect(report.stock.rows[0]).toMatchObject({
      variantId: "v1",
      locationId: "l1",
      owned: 4,
      shopify: 7,
    });
  });

  it("counts a missing inventory_balance row as owned 0", async () => {
    const tables = baseTables();
    tables.inventory_balance = [];
    currentSb = makeSb(tables);
    shopifyProducts = [shopifyProduct("Tee", [{ levels: [{ locationGid: L_GID, available: 3 }] }])];
    const report = await checkDualRunDrift(SHOP);
    expect(report.stock.count).toBe(1);
    expect(report.stock.rows[0]).toMatchObject({ owned: 0, shopify: 3 });
  });

  it("clamps owned sellable at 0 so an over-unavailable balance matches Shopify 0", async () => {
    const tables = baseTables();
    tables.inventory_balance = [
      { shop_id: SHOP, variant_id: "v1", location_id: "l1", on_hand: 1, unavailable: 5 },
    ];
    currentSb = makeSb(tables);
    shopifyProducts = [shopifyProduct("Tee", [{ levels: [{ locationGid: L_GID, available: 0 }] }])];
    const report = await checkDualRunDrift(SHOP);
    expect(report.stock.count).toBe(0);
    expect(report.pass).toBe(true);
  });

  it("skips the stock compare for untracked variants", async () => {
    shopifyProducts = [
      shopifyProduct("Tee", [{ tracked: false, levels: [{ locationGid: L_GID, available: 99 }] }]),
    ];
    const report = await checkDualRunDrift(SHOP);
    expect(report.stock.count).toBe(0);
    expect(report.pass).toBe(true);
  });

  it("counts an unbridged active Shopify variant as shopify-only with a sample title", async () => {
    shopifyProducts = [
      shopifyProduct("Tee", [{}]),
      shopifyProduct("New Hat", [{ gid: "gid://shopify/ProductVariant/999" }]),
    ];
    const report = await checkDualRunDrift(SHOP);
    expect(report.variantsChecked).toBe(1);
    expect(report.shopifyOnly.count).toBe(1);
    expect(report.shopifyOnly.sample[0]).toContain("New Hat");
    expect(report.pass).toBe(false);
  });

  it("ignores unbridged variants on draft or archived Shopify products", async () => {
    shopifyProducts = [
      shopifyProduct("Tee", [{}]),
      shopifyProduct("Draft Hat", [{ gid: "gid://shopify/ProductVariant/999" }], "DRAFT"),
    ];
    const report = await checkDualRunDrift(SHOP);
    expect(report.shopifyOnly.count).toBe(0);
    expect(report.pass).toBe(true);
  });

  it("counts a bridge pointing at a deleted owned variant as shopify-only", async () => {
    const tables = baseTables();
    tables.variant_dim = [];
    currentSb = makeSb(tables);
    const report = await checkDualRunDrift(SHOP);
    expect(report.variantsChecked).toBe(0);
    expect(report.shopifyOnly.count).toBe(1);
  });

  it("counts a bridged owned variant missing from the Shopify sweep as owned-only", async () => {
    shopifyProducts = [];
    const report = await checkDualRunDrift(SHOP);
    expect(report.ownedOnly.count).toBe(1);
    expect(report.ownedOnly.sample[0]).toBe(LABEL);
    expect(report.pass).toBe(false);
  });

  it("counts levels at unbridged locations instead of comparing them", async () => {
    shopifyProducts = [
      shopifyProduct("Tee", [
        { levels: [{ locationGid: "gid://shopify/Location/777", available: 4 }] },
      ]),
    ];
    const report = await checkDualRunDrift(SHOP);
    expect(report.unmatchedLocations).toBe(1);
    expect(report.stock.count).toBe(0);
    expect(report.pass).toBe(false);
  });

  it("flags a product whose variant list hits the fetchProducts page cap as truncated", async () => {
    const tables = baseTables();
    tables.import_map = [
      { shop_id: SHOP, entity_type: "location", external_id: L_GID, owned_id: "l1" },
    ];
    tables.variant_dim = [];
    tables.inventory_balance = [];
    const variants: ShopifyVariantOpts[] = [];
    for (let i = 0; i < 40; i++) {
      const gid = `gid://shopify/ProductVariant/${i}`;
      tables.import_map.push({
        shop_id: SHOP,
        entity_type: "variant",
        external_id: gid,
        owned_id: `v${i}`,
      });
      tables.variant_dim.push({
        shop_id: SHOP,
        id: `v${i}`,
        sku: `S${i}`,
        title: "Small",
        retail_price_cents: 1000,
        product: { title: "Tee" },
      });
      variants.push({ gid, price: "10.00", tracked: false });
    }
    currentSb = makeSb(tables);
    shopifyProducts = [shopifyProduct("Tee", variants)];
    const report = await checkDualRunDrift(SHOP);
    expect(report.truncated.count).toBe(1);
    expect(report.truncated.sample[0]).toBe("Tee");
    expect(report.pass).toBe(false);
  });

  it("keeps exact counts while capping detail rows at 50", async () => {
    const tables = baseTables();
    tables.import_map = [
      { shop_id: SHOP, entity_type: "location", external_id: L_GID, owned_id: "l1" },
    ];
    tables.variant_dim = [];
    const perProduct: ShopifyVariantOpts[][] = [[], []];
    for (let i = 0; i < 60; i++) {
      const gid = `gid://shopify/ProductVariant/${i}`;
      tables.import_map.push({
        shop_id: SHOP,
        entity_type: "variant",
        external_id: gid,
        owned_id: `v${i}`,
      });
      tables.variant_dim.push({
        shop_id: SHOP,
        id: `v${i}`,
        sku: `S${i}`,
        title: "Small",
        retail_price_cents: 500,
        product: { title: "Tee" },
      });
      // Two products of 30 variants each so neither hits the 40-variant cap.
      perProduct[i < 30 ? 0 : 1].push({ gid, price: "10.00", tracked: false });
    }
    currentSb = makeSb(tables);
    shopifyProducts = [shopifyProduct("Tee", perProduct[0]), shopifyProduct("Tee", perProduct[1])];
    const report = await checkDualRunDrift(SHOP);
    expect(report.price.count).toBe(60);
    expect(report.price.rows).toHaveLength(50);
    expect(report.truncated.count).toBe(0);
  });

  it("answers not_connected (409) for a shop without a Shopify domain", async () => {
    const tables = baseTables();
    tables.shops = [{ id: SHOP, shop_domain: null }];
    currentSb = makeSb(tables);
    const err = await checkDualRunDrift(SHOP).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CalderynError);
    expect((err as CalderynError).code).toBe("not_connected");
    expect((err as CalderynError).status).toBe(409);
  });

  it("wraps a Shopify transport failure as shopify_unreachable (502)", async () => {
    fetchImpl = async function* () {
      throw new Error("Admin GraphQL error: boom");
      yield undefined;
    };
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const err = await checkDualRunDrift(SHOP).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CalderynError);
      expect((err as CalderynError).code).toBe("shopify_unreachable");
      expect((err as CalderynError).status).toBe(502);
      expect(consoleWarn).toHaveBeenCalled();
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it("propagates a DB failure as-is (not shopify_unreachable)", async () => {
    currentSb = makeSb({});
    await expect(checkDualRunDrift(SHOP)).rejects.toThrow("shops: no row");
  });

  it("requires a shopId", async () => {
    await expect(checkDualRunDrift("")).rejects.toThrow("shopId is required");
  });
});
