import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory stand-in for the tables loadOrderDetail touches (native `orders` spine +
// the imported/history tables). Canonical Builder pattern from checkout.server.test.ts,
// extended with .order()/.limit() (the default-shipping-address lookup needs both) and
// jsonb `->>` path filters (the refund-audit lookup filters params->>order_id — see
// action_audit.params in app/lib/actions/refund.server.ts) since real PostgREST supports
// both and the fake must model them to test the real query shape.
const store = vi.hoisted(() => {
  type Row = Record<string, any>;
  const db: Record<string, Row[]> = {
    orders: [],
    order_line: [],
    variant_dim: [],
    buyer_dim: [],
    buyer_address: [],
    fulfillment: [],
    fulfillment_line: [],
    order_note: [],
    order_tag: [],
    order_state_transition: [],
    action_audit: [],
    transaction_ledger: [],
    imported_order: [],
    imported_order_line: [],
    imported_refund: [],
  };

  class Builder {
    private op: "select" | "insert" = "select";
    private filters: Array<[string, unknown]> = [];
    private inFilters: Array<[string, unknown[]]> = [];
    private orderBy: { col: string; ascending: boolean } | null = null;
    private limitN: number | null = null;
    private wantSingle = false;
    private readonly table: string;

    constructor(table: string) {
      this.table = table;
    }
    select(_cols?: string) {
      return this;
    }
    eq(col: string, val: unknown) {
      this.filters.push([col, val]);
      return this;
    }
    in(col: string, vals: unknown[]) {
      this.inFilters.push([col, vals]);
      return this;
    }
    order(col: string, opts?: { ascending?: boolean }) {
      this.orderBy = { col, ascending: opts?.ascending !== false };
      return this;
    }
    limit(n: number) {
      this.limitN = n;
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
      return { data: this.wantSingle ? (rows[0] ?? null) : rows, error: null };
    }
    private matchesJsonPath(row: Row, col: string, val: unknown): boolean {
      const [jsonCol, key] = col.split("->>");
      const container = row[jsonCol] as Row | undefined;
      return container != null && String(container[key]) === String(val);
    }
    private matches(row: Row): boolean {
      const eqOk = this.filters.every(([c, v]) => (c.includes("->>") ? this.matchesJsonPath(row, c, v) : row[c] === v));
      const inOk = this.inFilters.every(([c, vals]) => vals.includes(row[c]));
      return eqOk && inOk;
    }
    private run(): { data: unknown; error: unknown } {
      const t = db[this.table];
      let matched = t.filter((r) => this.matches(r));
      if (this.orderBy) {
        const { col, ascending } = this.orderBy;
        matched = [...matched].sort((a, b) => {
          const av = a[col];
          const bv = b[col];
          if (av === bv) return 0;
          const cmp = av > bv ? 1 : -1;
          return ascending ? cmp : -cmp;
        });
      }
      if (this.limitN != null) matched = matched.slice(0, this.limitN);
      return this.wrap(matched);
    }
  }

  const client = { from: (table: string) => new Builder(table) };
  return { db, client };
});

vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => store.client }));

// eslint-disable-next-line import/first -- imports must follow vi.mock so the fake registers first
import { loadOrderDetail } from "./detail.server";

beforeEach(() => {
  for (const k of Object.keys(store.db)) store.db[k].length = 0;
});

describe("loadOrderDetail — native branch", () => {
  it("assembles lines, fulfilledQuantity math, timeline order, and ledger-derived refundable total", async () => {
    store.db.orders.push({
      id: "order-1",
      shop_id: "shop-1",
      buyer_id: "buyer-1",
      state: "partially_fulfilled",
      financial_status: "partially_refunded",
      subtotal_cents: 5000,
      shipping_cents: 500,
      tax_cents: 200,
      total_cents: 5700,
      currency: "usd",
      attribution: { channel: "google" },
      channel: "storefront",
      archived_at: null,
      cancelled_at: null,
      cancel_reason: null,
      created_at: "2026-07-01T10:00:00.000Z",
    });
    store.db.buyer_dim.push({ id: "buyer-1", shop_id: "shop-1", email_normalized: "buyer@example.com" });
    store.db.buyer_address.push({
      shop_id: "shop-1",
      buyer_id: "buyer-1",
      kind: "shipping",
      is_default: true,
      name: "Buyer One",
      line1: "123 Main St",
      line2: null,
      city: "Springfield",
      region: "IL",
      postal: "62701",
      country: "US",
    });
    store.db.order_line.push(
      {
        id: "line-1",
        shop_id: "shop-1",
        order_id: "order-1",
        variant_id: "v-1",
        quantity: 3,
        unit_price_cents: 1000,
        title_snapshot: "Cotton Tee",
      },
      {
        id: "line-2",
        shop_id: "shop-1",
        order_id: "order-1",
        variant_id: "v-2",
        quantity: 1,
        unit_price_cents: 2000,
        title_snapshot: "Wool Hat",
      },
    );
    store.db.variant_dim.push(
      { id: "v-1", shop_id: "shop-1", sku: "TEE-S" },
      { id: "v-2", shop_id: "shop-1", sku: "HAT-1" },
    );
    // One PARTIAL fulfillment: only line-1 shipped, 2 of its 3 units.
    store.db.fulfillment.push({
      id: "fulfillment-1",
      shop_id: "shop-1",
      order_id: "order-1",
      tracking_number: "1Z999",
      carrier: "UPS",
      notified_at: "2026-07-02T12:00:00.000Z",
      created_at: "2026-07-02T11:00:00.000Z",
    });
    store.db.fulfillment_line.push({
      id: "fline-1",
      shop_id: "shop-1",
      fulfillment_id: "fulfillment-1",
      order_line_id: "line-1",
      quantity: 2,
    });
    store.db.order_note.push({
      id: "note-1",
      shop_id: "shop-1",
      order_id: "order-1",
      author_email: "staff@calderyncompany.com",
      body: "Gift-wrapped per request.",
      created_at: "2026-07-01T15:00:00.000Z",
    });
    store.db.action_audit.push({
      id: "audit-1",
      shop_id: "shop-1",
      action_kind: "issue_refund",
      outcome: "succeeded",
      params: { order_id: "order-1", amount_cents: 1000 },
      created_at: "2026-07-03T09:00:00.000Z",
    });
    store.db.order_state_transition.push({
      id: "trans-1",
      shop_id: "shop-1",
      order_id: "order-1",
      to_state: "paid",
      reason: null,
      occurred_at: "2026-07-01T10:05:00.000Z",
    });

    const detail = await loadOrderDetail("shop-1", "order-1");
    expect(detail).not.toBeNull();
    if (!detail) return;

    expect(detail.source).toBe("calderyn");
    expect(detail.readOnly).toBe(false);
    expect(detail.id).toBe("order-1");

    // fulfilledQuantity math: line-1 got 2 of 3 shipped; line-2 got none.
    const line1 = detail.lines.find((l) => l.id === "line-1");
    const line2 = detail.lines.find((l) => l.id === "line-2");
    expect(line1).toMatchObject({ sku: "TEE-S", quantity: 3, fulfilledQuantity: 2 });
    expect(line2).toMatchObject({ sku: "HAT-1", quantity: 1, fulfilledQuantity: 0 });

    expect(detail.fulfillments).toHaveLength(1);
    expect(detail.fulfillments[0]).toMatchObject({
      trackingNumber: "1Z999",
      carrier: "UPS",
      units: 2,
      notifiedAt: "2026-07-02T12:00:00.000Z",
    });

    // remainingRefundableCents comes from the ledger (no capture row here -> falls back
    // to the gross total, matching remainingRefundableByOrder's documented fallback).
    expect(detail.remainingRefundableCents).toBe(detail.totalCents);

    // Timeline: transition, note, refund, and fulfillment events all present, sorted
    // newest-first (2026-07-03 refund > 2026-07-02 fulfillment > 2026-07-01 note > transition).
    expect(detail.timeline.map((e) => e.kind)).toEqual(["refund", "fulfillment", "note", "transition"]);
    expect(detail.timeline[0]).toMatchObject({ kind: "refund", title: "Refund issued" });
    expect(detail.timeline[3]).toMatchObject({ kind: "transition", title: "Paid" });

    expect(detail.buyer).toEqual({ id: "buyer-1", email: "buyer@example.com" });
    expect(detail.shippingAddress).toMatchObject({ line1: "123 Main St", city: "Springfield" });
    expect(detail.discountCents).toBe(0);
  });

  it("resolves a calderyn:-prefixed id the same as a bare uuid", async () => {
    store.db.orders.push({
      id: "order-2",
      shop_id: "shop-1",
      buyer_id: null,
      state: "paid",
      financial_status: "paid",
      subtotal_cents: 1000,
      shipping_cents: 0,
      tax_cents: 0,
      total_cents: 1000,
      currency: "usd",
      attribution: null,
      channel: "storefront",
      archived_at: null,
      cancelled_at: null,
      cancel_reason: null,
      created_at: "2026-07-01T00:00:00.000Z",
    });

    const bare = await loadOrderDetail("shop-1", "order-2");
    const prefixed = await loadOrderDetail("shop-1", "calderyn:order-2");
    expect(bare).not.toBeNull();
    expect(prefixed).toEqual(bare);
  });

  it("flows archived/cancelled stamps through", async () => {
    store.db.orders.push({
      id: "order-3",
      shop_id: "shop-1",
      buyer_id: null,
      state: "cancelled",
      financial_status: "voided",
      subtotal_cents: 1000,
      shipping_cents: 0,
      tax_cents: 0,
      total_cents: 1000,
      currency: "usd",
      attribution: null,
      channel: "storefront",
      archived_at: "2026-07-05T00:00:00.000Z",
      cancelled_at: "2026-07-04T00:00:00.000Z",
      cancel_reason: "buyer requested",
      created_at: "2026-07-01T00:00:00.000Z",
    });

    const detail = await loadOrderDetail("shop-1", "order-3");
    expect(detail).toMatchObject({
      archivedAt: "2026-07-05T00:00:00.000Z",
      cancelledAt: "2026-07-04T00:00:00.000Z",
      cancelReason: "buyer requested",
    });
  });

  it("returns null for an unknown native id", async () => {
    const detail = await loadOrderDetail("shop-1", "does-not-exist");
    expect(detail).toBeNull();
  });
});

describe("loadOrderDetail — imported (shopify:) branch", () => {
  it("marks readOnly true and titles lines from sku_dim", async () => {
    store.db.imported_order.push({
      id: "imp-1",
      shop_id: "shop-1",
      external_id: "gid://shopify/Order/999",
      order_number: "1042",
      financial_status: "refunded",
      currency: "usd",
      total_cents: 3000,
      subtotal_cents: 2800,
      shipping_cents: 200,
      tax_cents: 0,
      discount_cents: 0,
      processed_at: "2026-06-01T00:00:00.000Z",
      buyer_id: "buyer-9",
    });
    store.db.buyer_dim.push({ id: "buyer-9", shop_id: "shop-1", email_normalized: "history@example.com" });
    store.db.imported_order_line.push({
      id: "impline-1",
      shop_id: "shop-1",
      imported_order_id: "imp-1",
      quantity: 2,
      price_cents: 1400,
      sku_dim: { sku: "MUG-1", title: "Blue Mug" },
    });
    store.db.imported_refund.push({
      shop_id: "shop-1",
      imported_order_id: "imp-1",
      subtotal_cents: 1400,
      processed_at: "2026-06-05T00:00:00.000Z",
    });

    const detail = await loadOrderDetail("shop-1", "shopify:imp-1");
    expect(detail).not.toBeNull();
    if (!detail) return;

    expect(detail.source).toBe("shopify");
    expect(detail.readOnly).toBe(true);
    expect(detail.ref).toBe("#1042");
    expect(detail.lines).toEqual([
      { id: "impline-1", title: "Blue Mug", sku: "MUG-1", quantity: 2, unitPriceCents: 1400, fulfilledQuantity: 0 },
    ]);
    expect(detail.fulfillments).toEqual([]);
    expect(detail.tags).toEqual([]);
    expect(detail.remainingRefundableCents).toBe(0);
    expect(detail.refundedCents).toBe(1400);
    expect(detail.buyer).toEqual({ id: "buyer-9", email: "history@example.com" });
    expect(detail.timeline).toEqual([
      { kind: "refund", at: "2026-06-05T00:00:00.000Z", title: "Refund issued", detail: "$14.00", author: null },
    ]);
  });

  it("returns null for an unknown imported id", async () => {
    const detail = await loadOrderDetail("shop-1", "shopify:does-not-exist");
    expect(detail).toBeNull();
  });
});
