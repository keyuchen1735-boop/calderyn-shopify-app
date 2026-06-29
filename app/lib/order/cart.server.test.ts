import { describe, it, expect, beforeEach, vi } from "vitest";
import type { StoreProduct } from "~/lib/storefront/catalog";

// In-memory stand-in for the cart tables. Enforces the migration constraints that the
// helpers depend on, so behavior is tested against REAL rules, not bare mocks:
//   - cart_line COMPOSITE FK (shop_id, cart_id) -> cart(shop_id, id): a line whose
//     (shop_id, cart_id) pair has no parent cart is rejected (also the cross-tenant guard).
//   - cart_line UNIQUE (shop_id, cart_id, variant_id): a second INSERT for the same variant
//     is rejected (proving addCartLine must increment the existing line, not duplicate it).
const store = vi.hoisted(() => {
  type Row = Record<string, any>;
  const db: Record<string, Row[]> = { cart: [], cart_line: [] };

  class Builder {
    private op: "select" | "insert" | "update" = "select";
    private payload: Row = {};
    private vals: Row = {};
    private filters: Array<[string, unknown]> = [];
    private wantSingle = false;
    private readonly table: string;

    constructor(table: string) {
      this.table = table;
    }
    insert(payload: Row) {
      this.op = "insert";
      this.payload = payload;
      return this;
    }
    update(vals: Row) {
      this.op = "update";
      this.vals = vals;
      return this;
    }
    select(_cols?: string) {
      return this;
    }
    eq(col: string, val: unknown) {
      this.filters.push([col, val]);
      return this;
    }
    single() {
      this.wantSingle = true;
      return this;
    }
    maybeSingle() {
      this.wantSingle = true;
      return this;
    }
    then(resolve: (v: { data: unknown; error: unknown }) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve(this.run()).then(resolve, reject);
    }

    private wrap(rows: Row[]) {
      return { data: this.wantSingle ? rows[0] ?? null : rows, error: null };
    }
    private run(): { data: unknown; error: unknown } {
      const t = db[this.table];
      if (this.op === "insert") {
        if (this.table === "cart_line") {
          const parent = db.cart.find(
            (c) => c.shop_id === this.payload.shop_id && c.id === this.payload.cart_id,
          );
          if (!parent) {
            return { data: null, error: { message: "composite FK (shop_id, cart_id) -> cart violated" } };
          }
          const dup = db.cart_line.find(
            (r) =>
              r.shop_id === this.payload.shop_id &&
              r.cart_id === this.payload.cart_id &&
              r.variant_id === this.payload.variant_id,
          );
          if (dup) {
            return { data: null, error: { message: "duplicate key: cart_line (shop_id, cart_id, variant_id)" } };
          }
        }
        const row: Row = {
          id: `${this.table}-${t.length + 1}`,
          created_at: new Date().toISOString(),
          ...this.payload,
        };
        t.push(row);
        return this.wrap([row]);
      }
      if (this.op === "update") {
        const matched = t.filter((r) => this.filters.every(([c, v]) => r[c] === v));
        for (const r of matched) Object.assign(r, this.vals);
        return this.wrap(matched);
      }
      const matched = t.filter((r) => this.filters.every(([c, v]) => r[c] === v));
      return this.wrap(matched);
    }
  }

  const client = { from: (table: string) => new Builder(table) };
  return { db, client };
});

// A pristine catalog fixture that beforeEach deep-clones into a mutable `catalog` so a test
// can change a variant's currency/price mid-flight (to prove the cart uses SNAPSHOTS, not the
// live catalog). Tee = $19.99 USD available, Hoodie = $54.99 USD unavailable, Cap = €30 EUR.
const PRISTINE: StoreProduct[] = [
  {
    id: "p-tee",
    handle: "cotton-tee",
    title: "Cotton Tee",
    description: "",
    images: [],
    variants: [{ id: "v-tee-s", sku: "TEE-S", title: "Small", priceCents: 1999, currency: "USD", available: true }],
    collections: ["apparel"],
  },
  {
    id: "p-hoodie",
    handle: "zip-hoodie",
    title: "Zip Hoodie",
    description: "",
    images: [],
    variants: [{ id: "v-hoodie-l", sku: "HOOD-L", title: "Large", priceCents: 5499, currency: "USD", available: false }],
    collections: ["apparel"],
  },
  {
    id: "p-cap",
    handle: "euro-cap",
    title: "Euro Cap",
    description: "",
    images: [],
    variants: [{ id: "v-cap", sku: "CAP", title: "One size", priceCents: 3000, currency: "EUR", available: true }],
    collections: ["accessories"],
  },
];

const catalog = vi.hoisted(() => ({ products: [] as StoreProduct[] }));

vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => store.client }));
vi.mock("~/lib/storefront/catalog.server", () => ({
  getCatalog: () => ({
    listProducts: async () => catalog.products,
    getProduct: async (_s: string, h: string) => catalog.products.find((p) => p.handle === h) ?? null,
    listCollections: async () => [],
  }),
}));

// eslint-disable-next-line import/first -- imports must follow vi.mock so the fakes register first
import { buildCart, addCartLine, priceCart } from "./cart.server";

beforeEach(() => {
  store.db.cart.length = 0;
  store.db.cart_line.length = 0;
  catalog.products = structuredClone(PRISTINE);
});

describe("buildCart", () => {
  it("creates a cart in state 'cart' with no buyer", async () => {
    const cart = await buildCart("shop-1");
    expect(cart.state).toBe("cart");
    expect(cart.buyerId).toBeNull();
    expect(store.db.cart).toHaveLength(1);
    expect(store.db.cart[0].shop_id).toBe("shop-1");
  });
});

describe("addCartLine", () => {
  it("snapshots unit price + currency + composed title from the catalog", async () => {
    const cart = await buildCart("shop-1");
    const line = await addCartLine("shop-1", cart.id, "v-tee-s", 2);
    expect(line.unitPriceCents).toBe(1999); // snapshot of catalog priceCents
    expect(line.currency).toBe("usd"); // snapshot of catalog currency (lowercased)
    expect(line.titleSnapshot).toBe("Cotton Tee - Small");
    expect(line.quantity).toBe(2);
    expect(store.db.cart_line[0]).toMatchObject({ shop_id: "shop-1", cart_id: cart.id, variant_id: "v-tee-s" });
  });

  it("increments the existing line on a repeat add instead of duplicating it", async () => {
    const cart = await buildCart("shop-1");
    const first = await addCartLine("shop-1", cart.id, "v-tee-s", 2);
    const second = await addCartLine("shop-1", cart.id, "v-tee-s", 3);
    expect(second.id).toBe(first.id); // same line
    expect(second.quantity).toBe(5); // 2 + 3
    expect(store.db.cart_line).toHaveLength(1); // no duplicate row
  });

  it("rejects a non-positive / non-integer quantity (fail visibly)", async () => {
    const cart = await buildCart("shop-1");
    await expect(addCartLine("shop-1", cart.id, "v-tee-s", 0)).rejects.toThrow(/positive integer/);
    await expect(addCartLine("shop-1", cart.id, "v-tee-s", 1.5)).rejects.toThrow(/positive integer/);
  });

  it("rejects a variant that does not exist in the catalog (fail visibly)", async () => {
    const cart = await buildCart("shop-1");
    await expect(addCartLine("shop-1", cart.id, "v-missing", 1)).rejects.toThrow(/not found in catalog/);
    expect(store.db.cart_line).toHaveLength(0);
  });

  it("rejects an unavailable variant (fail visibly)", async () => {
    const cart = await buildCart("shop-1");
    await expect(addCartLine("shop-1", cart.id, "v-hoodie-l", 1)).rejects.toThrow(/not available/);
    expect(store.db.cart_line).toHaveLength(0);
  });

  it("rejects a line whose (shop_id, cart_id) has no parent cart (composite FK / cross-tenant)", async () => {
    const cart = await buildCart("shop-A");
    // shop-B trying to attach a line to shop-A's cart id -> composite FK rejects it.
    await expect(addCartLine("shop-B", cart.id, "v-tee-s", 1)).rejects.toThrow(/composite FK/);
  });
});

describe("priceCart", () => {
  it("sums snapshotted line prices into an integer-cents subtotal", async () => {
    const cart = await buildCart("shop-1");
    await addCartLine("shop-1", cart.id, "v-tee-s", 2); // 1999 * 2 = 3998
    const priced = await priceCart("shop-1", cart.id);
    expect(priced.subtotalCents).toBe(3998);
    expect(priced.currency).toBe("usd");
    expect(priced.lines).toHaveLength(1);
    expect(Number.isInteger(priced.subtotalCents)).toBe(true);
  });

  it("prices an empty cart to 0 / usd", async () => {
    const cart = await buildCart("shop-1");
    const priced = await priceCart("shop-1", cart.id);
    expect(priced.subtotalCents).toBe(0);
    expect(priced.currency).toBe("usd");
  });

  it("scopes pricing to the cart: other carts' lines are not summed", async () => {
    const a = await buildCart("shop-1");
    const b = await buildCart("shop-1");
    await addCartLine("shop-1", a.id, "v-tee-s", 1);
    await addCartLine("shop-1", b.id, "v-tee-s", 3);
    expect((await priceCart("shop-1", a.id)).subtotalCents).toBe(1999);
    expect((await priceCart("shop-1", b.id)).subtotalCents).toBe(1999 * 3);
  });

  it("prices from the SNAPSHOT: a later catalog price/currency change does not re-denominate the cart", async () => {
    const cart = await buildCart("shop-1");
    await addCartLine("shop-1", cart.id, "v-tee-s", 1); // snapshot: 1999 USD

    // The merchant re-prices + re-denominates the variant AFTER it was added to the cart.
    catalog.products[0].variants[0].currency = "EUR";
    catalog.products[0].variants[0].priceCents = 4999;

    const priced = await priceCart("shop-1", cart.id);
    expect(priced.currency).toBe("usd"); // still the snapshot currency
    expect(priced.subtotalCents).toBe(1999); // still the snapshot price
    expect(priced.lines[0].currency).toBe("usd");
  });

  it("fails visibly when a cart mixes currencies", async () => {
    const cart = await buildCart("shop-1");
    await addCartLine("shop-1", cart.id, "v-tee-s", 1); // USD
    await addCartLine("shop-1", cart.id, "v-cap", 1); // EUR
    await expect(priceCart("shop-1", cart.id)).rejects.toThrow(/mixes currencies/);
  });
});
