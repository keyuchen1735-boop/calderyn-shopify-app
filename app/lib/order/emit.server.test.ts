import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory stand-in for the OLTP source tables (orders, order_line, sku_dim) + the warehouse
// fact tables (order_fact, order_line_fact, ad_click_ref). The fake HONORS the onConflict keys
// so idempotency is tested against the REAL upsert contract, not a bare mock:
//   - order_fact      onConflict (shop_id, external_id)
//   - order_line_fact onConflict (order_id, external_line_id)
//   - ad_click_ref    onConflict (order_id, platform, click_id)
const store = vi.hoisted(() => {
  type Row = Record<string, any>;
  const db: Record<string, Row[]> = {
    orders: [],
    order_line: [],
    sku_dim: [],
    order_fact: [],
    order_line_fact: [],
    ad_click_ref: [],
  };

  class Builder {
    private op: "select" | "insert" | "upsert" = "select";
    private payload: Row | Row[] = {};
    private conflict: string[] = [];
    private filters: Array<[string, unknown]> = [];
    private wantSingle = false;
    private readonly table: string;

    constructor(table: string) {
      this.table = table;
    }
    insert(payload: Row | Row[]) {
      this.op = "insert";
      this.payload = payload;
      return this;
    }
    upsert(payload: Row | Row[], opts?: { onConflict?: string }) {
      this.op = "upsert";
      this.payload = payload;
      this.conflict = opts?.onConflict ? opts.onConflict.split(",").map((c) => c.trim()) : [];
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
    private insertOne(p: Row): Row {
      const t = db[this.table];
      const row: Row = { id: `${this.table}-${t.length + 1}`, ...p };
      t.push(row);
      return row;
    }
    private run(): { data: unknown; error: unknown } {
      const t = db[this.table];
      if (this.op === "insert") {
        const rows = (Array.isArray(this.payload) ? this.payload : [this.payload]).map((p) => this.insertOne(p));
        return this.wrap(rows);
      }
      if (this.op === "upsert") {
        const rows = (Array.isArray(this.payload) ? this.payload : [this.payload]).map((p) => {
          const existing = this.conflict.length
            ? t.find((r) => this.conflict.every((c) => r[c] === p[c]))
            : undefined;
          if (existing) {
            Object.assign(existing, p);
            return existing;
          }
          return this.insertOne(p);
        });
        return this.wrap(rows);
      }
      const matched = t.filter((r) => this.filters.every(([c, v]) => r[c] === v));
      return this.wrap(matched);
    }
  }

  const client = { from: (table: string) => new Builder(table) };
  return { db, client };
});

vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => store.client }));

// eslint-disable-next-line import/first -- import must follow vi.mock so the supabase fake registers first
import { emitPaidOrder } from "./emit.server";

const PAID_AT = "2026-06-29T12:00:00.000Z";

function seedOrder(attribution: unknown = {}, state = "paid") {
  store.db.orders.push({
    id: "ord-1",
    shop_id: "shop-1",
    state,
    subtotal_cents: 3998,
    shipping_cents: 0,
    tax_cents: 0,
    total_cents: 3998,
    currency: "usd",
    attribution,
    created_at: "2026-06-29T11:59:00.000Z",
  });
  store.db.order_line.push({
    id: "ol-1",
    shop_id: "shop-1",
    order_id: "ord-1",
    variant_id: "v-tee-s",
    quantity: 2,
    unit_price_cents: 1999,
    title_snapshot: "Cotton Tee - Small",
  });
}

beforeEach(() => {
  for (const k of Object.keys(store.db)) store.db[k].length = 0;
});

describe("emitPaidOrder", () => {
  it("emits an order_fact with a Calderyn-native GID + monotonic source_version and the line facts", async () => {
    seedOrder();
    store.db.sku_dim.push({ id: "sku-1", shop_id: "shop-1", external_id: "v-tee-s" });

    const res = await emitPaidOrder("shop-1", "ord-1", PAID_AT);

    expect(res).toMatchObject({
      externalId: "gid://calderyn/Order/ord-1",
      sourceVersion: Date.parse(PAID_AT),
      lineCount: 1,
      clickRefCount: 0,
      skipped: false,
    });
    expect(store.db.order_fact).toHaveLength(1);
    expect(store.db.order_fact[0]).toMatchObject({
      shop_id: "shop-1",
      external_id: "gid://calderyn/Order/ord-1", // never collides with gid://shopify/...
      order_number: "ord-1",
      total_cents: 3998,
      subtotal_cents: 3998,
      discount_cents: 0,
      currency: "USD", // uppercased to match Shopify-origin warehouse rows
      financial_status: "paid",
      source_version: Date.parse(PAID_AT),
    });
    // line fact carries a stable native line GID + resolves variant -> sku_dim.id.
    expect(store.db.order_line_fact).toHaveLength(1);
    expect(store.db.order_line_fact[0]).toMatchObject({
      order_id: store.db.order_fact[0].id,
      external_line_id: "gid://calderyn/OrderLine/ol-1",
      sku_id: "sku-1",
      quantity: 2,
      price_cents: 1999,
      total_cents: 3998,
    });
  });

  it("leaves sku_id null when the variant has no sku_dim match (never drops the line)", async () => {
    seedOrder(); // no sku_dim seeded
    await emitPaidOrder("shop-1", "ord-1", PAID_AT);
    expect(store.db.order_line_fact).toHaveLength(1);
    expect(store.db.order_line_fact[0].sku_id).toBeNull();
  });

  it("is idempotent: re-emitting overwrites the same rows (onConflict), never duplicates", async () => {
    seedOrder();
    store.db.sku_dim.push({ id: "sku-1", shop_id: "shop-1", external_id: "v-tee-s" });

    await emitPaidOrder("shop-1", "ord-1", PAID_AT);
    // A later transition bumps the version; re-emit must update in place, not duplicate.
    await emitPaidOrder("shop-1", "ord-1", "2026-06-29T13:00:00.000Z");

    expect(store.db.order_fact).toHaveLength(1);
    expect(store.db.order_line_fact).toHaveLength(1);
    expect(store.db.order_fact[0].source_version).toBe(Date.parse("2026-06-29T13:00:00.000Z"));
  });

  it("replays captured click-ids from the attribution snapshot as ad_click_ref rows", async () => {
    seedOrder({ clickIds: { fbclid: "fb-123", gclid: "gg-456" }, utm: { utm_source: "meta" } });

    const res = await emitPaidOrder("shop-1", "ord-1", PAID_AT);

    expect(res.clickRefCount).toBe(2);
    expect(store.db.ad_click_ref).toHaveLength(2);
    expect(store.db.ad_click_ref).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ order_id: store.db.order_fact[0].id, platform: "meta", click_id: "fb-123" }),
        expect.objectContaining({ platform: "google", click_id: "gg-456" }),
      ]),
    );
    // re-emit keeps the same breadcrumbs (onConflict order_id,platform,click_id).
    await emitPaidOrder("shop-1", "ord-1", PAID_AT);
    expect(store.db.ad_click_ref).toHaveLength(2);
  });

  it("emits no ad_click_ref rows for an empty attribution snapshot (does not fabricate)", async () => {
    seedOrder({}); // empty snapshot
    const res = await emitPaidOrder("shop-1", "ord-1", PAID_AT);
    expect(res.clickRefCount).toBe(0);
    expect(store.db.ad_click_ref).toHaveLength(0);
  });

  it("throws when the order is not found for the shop (fail visibly)", async () => {
    await expect(emitPaidOrder("shop-1", "ghost", PAID_AT)).rejects.toThrow(/not found for shop/);
  });

  it("skips emission (no facts written) for a go-live test probe (channel='test')", async () => {
    // The 50c cutover probe reaches 'paid' but must never land in the warehouse
    // facts (order_fact has no channel column, so the analytics test-exclusion
    // cannot reach an emitted row).
    seedOrder();
    store.db.orders[0].channel = "test";
    store.db.sku_dim.push({ id: "sku-1", shop_id: "shop-1", external_id: "v-tee-s" });

    const res = await emitPaidOrder("shop-1", "ord-1", PAID_AT);

    expect(res).toMatchObject({ skipped: true, lineCount: 0, clickRefCount: 0 });
    expect(store.db.order_fact).toHaveLength(0);
    expect(store.db.order_line_fact).toHaveLength(0);
  });

  it("skips emission (no facts written) when the order is not currently paid — never re-asserts paid", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    seedOrder({}, "refunded"); // a stale succeeded redelivery for an order that has since refunded
    store.db.sku_dim.push({ id: "sku-1", shop_id: "shop-1", external_id: "v-tee-s" });

    const res = await emitPaidOrder("shop-1", "ord-1", PAID_AT);

    expect(res).toMatchObject({ skipped: true, lineCount: 0, clickRefCount: 0 });
    expect(store.db.order_fact).toHaveLength(0); // nothing written for a non-paid order
    expect(store.db.order_line_fact).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/skipped.*not 'paid'/));
    warn.mockRestore();
  });
});
