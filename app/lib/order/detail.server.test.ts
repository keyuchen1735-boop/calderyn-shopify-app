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
    order_line_edit: [],
    order_return: [],
    order_return_line: [],
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
import { loadOrderDetail, isImportedOrderId, stripNativeOrderPrefix, nativeOrderExists } from "./detail.server";

beforeEach(() => {
  for (const k of Object.keys(store.db)) store.db[k].length = 0;
});

describe("isImportedOrderId / stripNativeOrderPrefix (Task 10 write-route guards)", () => {
  it("isImportedOrderId is true only for a shopify:-prefixed id", () => {
    expect(isImportedOrderId("shopify:123")).toBe(true);
    expect(isImportedOrderId("order-1")).toBe(false);
    expect(isImportedOrderId("calderyn:order-1")).toBe(false);
  });

  it("stripNativeOrderPrefix removes a calderyn: prefix and passes a bare id through unchanged", () => {
    expect(stripNativeOrderPrefix("calderyn:order-1")).toBe("order-1");
    expect(stripNativeOrderPrefix("order-1")).toBe("order-1");
  });
});

describe("nativeOrderExists", () => {
  it("true for a row scoped to the shop, false for a missing id or a cross-tenant id", async () => {
    store.db.orders.push({ id: "order-9", shop_id: "shop-1" });
    expect(await nativeOrderExists("shop-1", "order-9")).toBe(true);
    expect(await nativeOrderExists("shop-1", "ghost")).toBe(false);
    expect(await nativeOrderExists("shop-2", "order-9")).toBe(false);
  });
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
    // Ledger fixture: full capture at checkout + partial refund matching the audit above.
    store.db.transaction_ledger.push(
      { shop_id: "shop-1", order_ref: "order-1", kind: "capture", amount_cents: 5700 },
      { shop_id: "shop-1", order_ref: "order-1", kind: "refund", amount_cents: -1000 },
    );

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

    // remainingRefundableCents comes from the ledger: capture (5700) - refund (1000) = 4700.
    expect(detail.remainingRefundableCents).toBe(4700);
    // refundedCents = total - remaining = 5700 - 4700 = 1000, matching the audit.
    expect(detail.refundedCents).toBe(1000);

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

  it("populates the returns card + return timeline events (Phase 4 Task 1)", async () => {
    store.db.orders.push({
      id: "order-returns",
      shop_id: "shop-1",
      buyer_id: null,
      state: "fulfilled",
      financial_status: "paid",
      subtotal_cents: 5000,
      shipping_cents: 0,
      tax_cents: 0,
      total_cents: 5000,
      currency: "usd",
      attribution: null,
      channel: "storefront",
      archived_at: null,
      cancelled_at: null,
      cancel_reason: null,
      created_at: "2026-07-01T00:00:00.000Z",
    });
    // A closed (received) return and a cancelled one, each with one line.
    store.db.order_return.push(
      {
        id: "return-1",
        shop_id: "shop-1",
        order_id: "order-returns",
        status: "closed",
        reason: "Wrong size",
        created_at: "2026-07-02T00:00:00.000Z",
        received_at: "2026-07-03T00:00:00.000Z",
        updated_at: "2026-07-03T00:00:00.000Z",
      },
      {
        id: "return-2",
        shop_id: "shop-1",
        order_id: "order-returns",
        status: "cancelled",
        reason: null,
        created_at: "2026-07-04T00:00:00.000Z",
        received_at: null,
        updated_at: "2026-07-04T05:00:00.000Z",
      },
    );
    store.db.order_return_line.push(
      { id: "rline-1", shop_id: "shop-1", return_id: "return-1", order_line_id: "line-x", quantity: 1, restock: true, refund_cents: 1000 },
      { id: "rline-2", shop_id: "shop-1", return_id: "return-2", order_line_id: "line-y", quantity: 1, restock: true, refund_cents: 500 },
    );

    const detail = await loadOrderDetail("shop-1", "order-returns");
    expect(detail).not.toBeNull();
    if (!detail) return;

    expect(detail.returns).toHaveLength(2);
    const closed = detail.returns.find((r) => r.id === "return-1");
    expect(closed).toMatchObject({ status: "closed", reason: "Wrong size", receivedAt: "2026-07-03T00:00:00.000Z" });
    expect(closed?.lines).toEqual([{ id: "rline-1", orderLineId: "line-x", quantity: 1, restock: true, refundCents: 1000 }]);
    const cancelled = detail.returns.find((r) => r.id === "return-2");
    expect(cancelled).toMatchObject({ status: "cancelled", receivedAt: null });

    const returnEvents = detail.timeline.filter((e) => e.kind === "return");
    // 2 "created" events + 1 "received" (return-1) + 1 "cancelled" (return-2) = 4.
    expect(returnEvents).toHaveLength(4);
    expect(returnEvents.map((e) => e.title).sort()).toEqual([
      "Return cancelled",
      "Return created",
      "Return created",
      "Return received",
    ]);
    const receivedEvent = returnEvents.find((e) => e.title === "Return received");
    expect(receivedEvent).toMatchObject({ at: "2026-07-03T00:00:00.000Z" });
    const cancelledEvent = returnEvents.find((e) => e.title === "Return cancelled");
    expect(cancelledEvent).toMatchObject({ at: "2026-07-04T05:00:00.000Z" });
  });

  it("nets a reduced line's quantity and surfaces an edit timeline event", async () => {
    store.db.orders.push({
      id: "order-edit-1",
      shop_id: "shop-1",
      buyer_id: null,
      state: "paid",
      financial_status: "paid",
      subtotal_cents: 3000,
      shipping_cents: 0,
      tax_cents: 0,
      total_cents: 3000,
      currency: "usd",
      attribution: null,
      channel: "storefront",
      archived_at: null,
      cancelled_at: null,
      cancel_reason: null,
      created_at: "2026-07-01T00:00:00.000Z",
    });
    store.db.order_line.push({
      id: "line-edited",
      shop_id: "shop-1",
      order_id: "order-edit-1",
      variant_id: "v-1",
      quantity: 5, // snapshot
      unit_price_cents: 1000,
      title_snapshot: "Cotton Tee",
    });
    store.db.order_line_edit.push({
      id: "edit-1",
      shop_id: "shop-1",
      order_id: "order-edit-1",
      order_line_id: "line-edited",
      old_quantity: 5,
      new_quantity: 2,
      refund_cents: 3000,
      created_at: "2026-07-02T00:00:00.000Z",
    });

    const detail = await loadOrderDetail("shop-1", "order-edit-1");
    expect(detail).not.toBeNull();
    if (!detail) return;

    const line = detail.lines.find((l) => l.id === "line-edited");
    // The list-visible quantity is the EFFECTIVE one (2), with the reduction (3) as additive detail.
    expect(line).toMatchObject({ quantity: 2, reducedQuantity: 3 });

    const editEvent = detail.timeline.find((e) => e.kind === "edit");
    expect(editEvent).toMatchObject({ title: "Reduced Cotton Tee to 2", detail: "Refunded $30.00" });
  });
});

describe("loadOrderDetail — signals (Phase 4 Task 4)", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  it("flags stuckUnfulfilled for a paid order created more than 3 days ago, with stuckDays set", async () => {
    const occurredAt = new Date(Date.now() - 4 * DAY_MS).toISOString();
    store.db.orders.push({
      id: "order-stuck",
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
      created_at: occurredAt,
    });

    const detail = await loadOrderDetail("shop-1", "order-stuck");
    expect(detail).not.toBeNull();
    if (!detail) return;
    expect(detail.signals.stuckUnfulfilled).toBe(true);
    expect(detail.signals.stuckDays).toBe(4);
  });

  it("does not flag a fresh paid order (under 3 days)", async () => {
    const occurredAt = new Date(Date.now() - 1 * DAY_MS).toISOString();
    store.db.orders.push({
      id: "order-fresh",
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
      created_at: occurredAt,
    });

    const detail = await loadOrderDetail("shop-1", "order-fresh");
    expect(detail).not.toBeNull();
    if (!detail) return;
    expect(detail.signals.stuckUnfulfilled).toBe(false);
    expect(detail.signals.stuckDays).toBeNull();
  });

  it("does not flag a fulfilled order regardless of age", async () => {
    const occurredAt = new Date(Date.now() - 30 * DAY_MS).toISOString();
    store.db.orders.push({
      id: "order-old-fulfilled",
      shop_id: "shop-1",
      buyer_id: null,
      state: "fulfilled",
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
      created_at: occurredAt,
    });

    const detail = await loadOrderDetail("shop-1", "order-old-fulfilled");
    expect(detail).not.toBeNull();
    if (!detail) return;
    expect(detail.signals.stuckUnfulfilled).toBe(false);
  });

  it("populates repeatCustomer + refundRisk from the buyer's other orders", async () => {
    store.db.buyer_dim.push({ id: "buyer-signals", shop_id: "shop-1", email_normalized: "signals@example.com" });
    store.db.orders.push(
      {
        id: "order-signals-current",
        shop_id: "shop-1",
        buyer_id: "buyer-signals",
        state: "paid",
        financial_status: "paid",
        subtotal_cents: 5000,
        shipping_cents: 0,
        tax_cents: 0,
        total_cents: 5000,
        currency: "usd",
        attribution: null,
        channel: "storefront",
        archived_at: null,
        cancelled_at: null,
        cancel_reason: null,
        created_at: new Date().toISOString(),
      },
      {
        id: "order-signals-prior",
        shop_id: "shop-1",
        buyer_id: "buyer-signals",
        state: "refunded",
        channel: "storefront",
      },
    );
    store.db.transaction_ledger.push(
      { shop_id: "shop-1", order_ref: "order-signals-current", kind: "capture", amount_cents: 5000 },
      { shop_id: "shop-1", order_ref: "order-signals-prior", kind: "capture", amount_cents: 5000 },
      { shop_id: "shop-1", order_ref: "order-signals-prior", kind: "refund", amount_cents: -4000 },
    );

    const detail = await loadOrderDetail("shop-1", "order-signals-current");
    expect(detail).not.toBeNull();
    if (!detail) return;

    // 2 purchase-state orders -> repeat customer; refund ratio 4000/10000 = 40% > 30% -> risk.
    expect(detail.signals).toMatchObject({ repeatCustomer: true, buyerOrderCount: 2, refundRisk: true });
  });

  it("reads all-quiet buyer signals for a guest order (no buyer_id)", async () => {
    store.db.orders.push({
      id: "order-guest",
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
      created_at: new Date().toISOString(),
    });

    const detail = await loadOrderDetail("shop-1", "order-guest");
    expect(detail).not.toBeNull();
    if (!detail) return;
    expect(detail.signals).toMatchObject({ repeatCustomer: false, buyerOrderCount: 0, refundRisk: false });
  });
});

describe("humanizeTransitionReason", () => {
  it("hides machine-generated reasons and preserves human text", async () => {
    // Import the helper by testing it through transitions
    store.db.orders.push({
      id: "order-reasons",
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

    // Test various machine-generated reasons that should be hidden (null)
    store.db.order_state_transition.push(
      {
        id: "trans-payment",
        shop_id: "shop-1",
        order_id: "order-reasons",
        to_state: "paid",
        reason: "payment_confirmed",
        occurred_at: "2026-07-01T10:00:00.000Z",
      },
      {
        id: "trans-fulfillment",
        shop_id: "shop-1",
        order_id: "order-reasons",
        to_state: "fulfilled",
        reason: "fulfillment:60ac5957-f168-4a3b-8f7a-2b8c3f3d5e7a",
        occurred_at: "2026-07-01T11:00:00.000Z",
      },
      {
        id: "trans-stripe",
        shop_id: "shop-1",
        order_id: "order-reasons",
        to_state: "refunded",
        reason: "stripe:evt_1234567890",
        occurred_at: "2026-07-01T12:00:00.000Z",
      },
      {
        id: "trans-checkout",
        shop_id: "shop-1",
        order_id: "order-reasons",
        to_state: "cancelled",
        reason: "checkout:timeout",
        occurred_at: "2026-07-01T13:00:00.000Z",
      },
      {
        id: "trans-agentic",
        shop_id: "shop-1",
        order_id: "order-reasons",
        to_state: "partially_fulfilled",
        reason: "agentic:auto_stock_rebalance",
        occurred_at: "2026-07-01T14:00:00.000Z",
      },
      {
        id: "trans-merchant",
        shop_id: "shop-1",
        order_id: "order-reasons",
        to_state: "cart",
        reason: "merchant:manual_adjustment",
        occurred_at: "2026-07-01T15:00:00.000Z",
      },
      {
        id: "trans-human",
        shop_id: "shop-1",
        order_id: "order-reasons",
        to_state: "cancelled",
        reason: "Customer changed their mind",
        occurred_at: "2026-07-01T16:00:00.000Z",
      },
      {
        id: "trans-null",
        shop_id: "shop-1",
        order_id: "order-reasons",
        to_state: "paid",
        reason: null,
        occurred_at: "2026-07-01T17:00:00.000Z",
      },
    );

    const detail = await loadOrderDetail("shop-1", "order-reasons");
    expect(detail).not.toBeNull();
    if (!detail) return;

    const transitions = detail.timeline.filter((e) => e.kind === "transition");
    expect(transitions).toHaveLength(8);

    // payment_confirmed → hidden
    expect(transitions[7]).toMatchObject({ detail: null });
    // fulfillment:* → hidden
    expect(transitions[6]).toMatchObject({ detail: null });
    // stripe:* → hidden
    expect(transitions[5]).toMatchObject({ detail: null });
    // checkout:* → hidden
    expect(transitions[4]).toMatchObject({ detail: null });
    // agentic:* → hidden
    expect(transitions[3]).toMatchObject({ detail: null });
    // merchant:* → hidden
    expect(transitions[2]).toMatchObject({ detail: null });
    // Human text → preserved
    expect(transitions[1]).toMatchObject({ detail: "Customer changed their mind" });
    // null → stays null
    expect(transitions[0]).toMatchObject({ detail: null });
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
      { id: "impline-1", variantId: null, title: "Blue Mug", sku: "MUG-1", quantity: 2, reducedQuantity: 0, unitPriceCents: 1400, fulfilledQuantity: 0 },
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
