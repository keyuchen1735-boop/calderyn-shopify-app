import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory stand-in for the `orders` + `payment_intent` tables the reaper reads/writes.
// Deliberately simpler than the house Builder style in checkout.server.test.ts — the reaper
// only does SELECT ... eq/lt/order/limit plus the payment_intent status UPDATE (the order
// state mutation goes through the mocked transitionOrder / releaseReservation).
// flags.failPiUpdate simulates a transient PostgREST failure on the local stamp, exercising
// the reaper's "best-effort — a failed stamp never skips the order cancellation" contract.
type Row = Record<string, any>;

const store = vi.hoisted(() => {
  const db: { orders: Row[]; payment_intent: Row[] } = { orders: [], payment_intent: [] };
  const flags = { failPiUpdate: false };
  return { db, flags };
});

class Builder {
  private op: "select" | "update" = "select";
  private vals: Row = {};
  private filters: Array<[string, unknown]> = [];
  private ltFilters: Array<[string, unknown]> = [];
  private orderCol: string | null = null;
  private limitN: number | null = null;
  private readonly table: "orders" | "payment_intent";
  constructor(table: "orders" | "payment_intent") {
    this.table = table;
  }
  select(_cols?: string) {
    return this;
  }
  update(vals: Row) {
    this.op = "update";
    this.vals = vals;
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push([col, val]);
    return this;
  }
  lt(col: string, val: unknown) {
    this.ltFilters.push([col, val]);
    return this;
  }
  order(col: string, _opts?: { ascending?: boolean }) {
    this.orderCol = col;
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }
  then(resolve: (v: { data: unknown; error: unknown }) => unknown, reject?: (e: unknown) => unknown) {
    return Promise.resolve(this.run()).then(resolve, reject);
  }
  private run() {
    let rows = store.db[this.table].filter(
      (r) =>
        this.filters.every(([c, v]) => r[c] === v) &&
        this.ltFilters.every(([c, v]) => r[c] < (v as string)),
    );
    if (this.op === "update") {
      if (this.table === "payment_intent" && store.flags.failPiUpdate) {
        return { data: null, error: { message: "simulated transient update failure" } };
      }
      for (const r of rows) Object.assign(r, this.vals);
      return { data: rows, error: null };
    }
    if (this.orderCol) {
      const col = this.orderCol;
      rows = [...rows].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0));
    }
    if (this.limitN != null) rows = rows.slice(0, this.limitN);
    return { data: rows, error: null };
  }
}

vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({ from: (table: "orders" | "payment_intent") => new Builder(table) }),
}));

const stripe = vi.hoisted(() => ({
  cancel: vi.fn(async () => ({})),
  retrieve: vi.fn(async () => ({ status: "canceled" })),
}));
vi.mock("~/lib/payments/stripe-client.server", () => ({
  getStripe: () => ({ paymentIntents: { cancel: stripe.cancel, retrieve: stripe.retrieve } }),
}));

const engine = vi.hoisted(() => ({ releaseReservation: vi.fn(async () => {}) }));
vi.mock("~/lib/inventory/engine.server", () => ({ releaseReservation: engine.releaseReservation }));

const orderLib = vi.hoisted(() => ({ transitionOrder: vi.fn(async () => ({})) }));
vi.mock("./order.server", () => ({ transitionOrder: orderLib.transitionOrder }));

// eslint-disable-next-line import/first -- imports must follow vi.mock so the fakes register first
import { reapAbandonedCheckouts } from "./abandon-reaper.server";

const NOW = new Date("2026-07-09T12:00:00.000Z");
const STALE_25H = new Date(NOW.getTime() - 25 * 60 * 60 * 1000).toISOString();
const FRESH_1H = new Date(NOW.getTime() - 1 * 60 * 60 * 1000).toISOString();

function seedOrder(id: string, shopId: string, state: string, createdAt: string) {
  store.db.orders.push({ id, shop_id: shopId, state, created_at: createdAt });
}
function seedPI(orderRef: string, shopId: string, stripePiId: string, status: string) {
  store.db.payment_intent.push({ order_ref: orderRef, shop_id: shopId, stripe_pi_id: stripePiId, status });
}
function piStatus(stripePiId: string): string | undefined {
  return store.db.payment_intent.find((p) => p.stripe_pi_id === stripePiId)?.status;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  store.db.orders.length = 0;
  store.db.payment_intent.length = 0;
  store.flags.failPiUpdate = false;
  stripe.cancel.mockResolvedValue({});
  stripe.retrieve.mockResolvedValue({ status: "canceled" });
});

describe("reapAbandonedCheckouts", () => {
  it("cancels a stale checkout_pending order with an open PI: voids the PI, releases holds, transitions to cancelled", async () => {
    seedOrder("order-1", "shop-1", "checkout_pending", STALE_25H);
    seedPI("order-1", "shop-1", "pi_open", "requires_payment_method");

    const result = await reapAbandonedCheckouts();

    expect(stripe.cancel).toHaveBeenCalledWith("pi_open");
    expect(engine.releaseReservation).toHaveBeenCalledWith("shop-1", "order-1");
    expect(orderLib.transitionOrder).toHaveBeenCalledWith(
      "shop-1",
      "order-1",
      "cancelled",
      "cron:abandoned_checkout",
    );
    // Local read-model stamped: without it listPendingIntents (status NOT IN succeeded,canceled)
    // would show the voided PI as pending on the Payments screen forever.
    expect(piStatus("pi_open")).toBe("canceled");
    expect(result).toEqual({ scanned: 1, cancelled: 1, skippedPaidRace: 0, failed: 0 });
  });

  it("skips an order with a succeeded PI row without cancelling, releasing, or transitioning anything", async () => {
    seedOrder("order-2", "shop-1", "checkout_pending", STALE_25H);
    seedPI("order-2", "shop-1", "pi_paid", "succeeded");

    const result = await reapAbandonedCheckouts();

    expect(stripe.cancel).not.toHaveBeenCalled();
    expect(engine.releaseReservation).not.toHaveBeenCalled();
    expect(orderLib.transitionOrder).not.toHaveBeenCalled();
    expect(piStatus("pi_paid")).toBe("succeeded"); // untouched — the webhook owns this row
    expect(result).toEqual({ scanned: 1, cancelled: 0, skippedPaidRace: 1, failed: 0 });
  });

  it("treats a cancel failure whose retrieve shows succeeded as a late-capture paid race: skips, no transition", async () => {
    seedOrder("order-3", "shop-1", "checkout_pending", STALE_25H);
    seedPI("order-3", "shop-1", "pi_racing", "requires_payment_method");
    stripe.cancel.mockRejectedValueOnce(new Error("payment_intent_unexpected_state"));
    stripe.retrieve.mockResolvedValueOnce({ status: "succeeded" });

    const result = await reapAbandonedCheckouts();

    expect(orderLib.transitionOrder).not.toHaveBeenCalled();
    expect(engine.releaseReservation).not.toHaveBeenCalled();
    // NEVER stamped on the paid race — the succeeded webhook owns that row's status.
    expect(piStatus("pi_racing")).toBe("requires_payment_method");
    expect(result).toEqual({ scanned: 1, cancelled: 0, skippedPaidRace: 1, failed: 0 });
  });

  it("proceeds to transition normally when a cancel failure's retrieve shows already-canceled", async () => {
    seedOrder("order-4", "shop-1", "checkout_pending", STALE_25H);
    seedPI("order-4", "shop-1", "pi_already_canceled", "requires_payment_method");
    stripe.cancel.mockRejectedValueOnce(new Error("payment_intent_unexpected_state"));
    stripe.retrieve.mockResolvedValueOnce({ status: "canceled" });

    const result = await reapAbandonedCheckouts();

    expect(orderLib.transitionOrder).toHaveBeenCalledWith(
      "shop-1",
      "order-4",
      "cancelled",
      "cron:abandoned_checkout",
    );
    // Stripe says the PI is already canceled — the stale local row gets synced too.
    expect(piStatus("pi_already_canceled")).toBe("canceled");
    expect(result).toEqual({ scanned: 1, cancelled: 1, skippedPaidRace: 0, failed: 0 });
  });

  it("still cancels the order when the local payment_intent status stamp fails (best-effort)", async () => {
    seedOrder("order-9", "shop-1", "checkout_pending", STALE_25H);
    seedPI("order-9", "shop-1", "pi_9", "requires_payment_method");
    store.flags.failPiUpdate = true;

    const result = await reapAbandonedCheckouts();

    // The Stripe-side void happened and the order cancellation proceeded; only the local
    // read-model stamp was lost (logged loudly, self-evident on the Payments screen).
    expect(stripe.cancel).toHaveBeenCalledWith("pi_9");
    expect(orderLib.transitionOrder).toHaveBeenCalledWith(
      "shop-1",
      "order-9",
      "cancelled",
      "cron:abandoned_checkout",
    );
    expect(piStatus("pi_9")).toBe("requires_payment_method"); // stamp genuinely failed
    expect(result).toEqual({ scanned: 1, cancelled: 1, skippedPaidRace: 0, failed: 0 });
  });

  it("skips the whole order (failed) when a cancel fails and the PI is still live — never cancels an order with a confirmable client_secret", async () => {
    seedOrder("order-live", "shop-1", "checkout_pending", STALE_25H);
    seedPI("order-live", "shop-1", "pi_still_live", "requires_payment_method");
    seedOrder("order-next", "shop-1", "checkout_pending", STALE_25H);
    seedPI("order-next", "shop-1", "pi_next", "requires_payment_method");
    // Transient Stripe error: the cancel fails but the PI is NOT terminal — still confirmable.
    stripe.cancel.mockRejectedValueOnce(new Error("stripe 503"));
    stripe.retrieve.mockResolvedValueOnce({ status: "requires_payment_method" });

    const result = await reapAbandonedCheckouts();

    // order-live was skipped entirely: no hold release, no transition, no local stamp — it stays
    // checkout_pending so the next hourly run retries the void.
    expect(engine.releaseReservation).not.toHaveBeenCalledWith("shop-1", "order-live");
    expect(orderLib.transitionOrder).not.toHaveBeenCalledWith(
      "shop-1",
      "order-live",
      "cancelled",
      "cron:abandoned_checkout",
    );
    expect(piStatus("pi_still_live")).toBe("requires_payment_method");
    // ...and the sweep continued to the next order, which cancelled normally.
    expect(orderLib.transitionOrder).toHaveBeenCalledTimes(1);
    expect(orderLib.transitionOrder).toHaveBeenCalledWith(
      "shop-1",
      "order-next",
      "cancelled",
      "cron:abandoned_checkout",
    );
    expect(piStatus("pi_next")).toBe("canceled");
    expect(result).toEqual({ scanned: 2, cancelled: 1, skippedPaidRace: 0, failed: 1 });
  });

  it("counts a mid-flight transitionOrder rejection (webhook won the race) as skippedPaidRace and keeps sweeping", async () => {
    seedOrder("order-5", "shop-1", "checkout_pending", STALE_25H);
    seedPI("order-5", "shop-1", "pi_5", "requires_payment_method");
    seedOrder("order-6", "shop-1", "checkout_pending", STALE_25H);
    seedPI("order-6", "shop-1", "pi_6", "requires_payment_method");
    orderLib.transitionOrder.mockRejectedValueOnce(new Error("order changed under us"));

    const result = await reapAbandonedCheckouts();

    expect(orderLib.transitionOrder).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ scanned: 2, cancelled: 1, skippedPaidRace: 1, failed: 0 });
  });

  it("isolates a failing order (release throws a non-race error) as `failed` and still processes the rest", async () => {
    seedOrder("order-7", "shop-1", "checkout_pending", STALE_25H);
    seedPI("order-7", "shop-1", "pi_7", "requires_payment_method");
    seedOrder("order-8", "shop-1", "checkout_pending", STALE_25H);
    seedPI("order-8", "shop-1", "pi_8", "requires_payment_method");
    engine.releaseReservation.mockRejectedValueOnce(new Error("transient RPC error"));

    const result = await reapAbandonedCheckouts();

    expect(orderLib.transitionOrder).toHaveBeenCalledTimes(1);
    expect(orderLib.transitionOrder).toHaveBeenCalledWith(
      "shop-1",
      "order-8",
      "cancelled",
      "cron:abandoned_checkout",
    );
    expect(result).toEqual({ scanned: 2, cancelled: 1, skippedPaidRace: 0, failed: 1 });
  });

  it("never selects orders younger than 24h or orders in other states", async () => {
    seedOrder("order-fresh", "shop-1", "checkout_pending", FRESH_1H);
    seedOrder("order-paid", "shop-1", "paid", STALE_25H);
    seedOrder("order-cancelled", "shop-1", "cancelled", STALE_25H);

    const result = await reapAbandonedCheckouts();

    expect(result).toEqual({ scanned: 0, cancelled: 0, skippedPaidRace: 0, failed: 0 });
    expect(stripe.cancel).not.toHaveBeenCalled();
    expect(orderLib.transitionOrder).not.toHaveBeenCalled();
    // Untouched: still exactly the states they were seeded with.
    expect(store.db.orders.find((o) => o.id === "order-fresh")?.state).toBe("checkout_pending");
    expect(store.db.orders.find((o) => o.id === "order-paid")?.state).toBe("paid");
    expect(store.db.orders.find((o) => o.id === "order-cancelled")?.state).toBe("cancelled");
  });
});
