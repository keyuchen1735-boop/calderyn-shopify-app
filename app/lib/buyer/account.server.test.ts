import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory stand-in for buyer_dim / buyer_address / orders. Supports the read + delete shapes
// the account helpers use (eq/is/order/maybeSingle/delete).
const store = vi.hoisted(() => {
  type Row = Record<string, any>;
  const db: Record<string, Row[]> = { buyer_dim: [], buyer_address: [], orders: [], order_fulfillment: [] };

  class Builder {
    private op: "select" | "delete" = "select";
    private filters: Array<[string, unknown]> = [];
    private inFilters: Array<[string, unknown[]]> = [];
    private nullFilters: string[] = [];
    private notNullFilters: string[] = [];
    private wantSingle = false;
    private readonly table: string;
    constructor(table: string) {
      this.table = table;
    }
    select(_c?: string) {
      return this;
    }
    delete() {
      this.op = "delete";
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
    is(col: string, _val: null) {
      this.nullFilters.push(col);
      return this;
    }
    not(col: string, _op: "is", _val: null) {
      // Models PostgREST `.not(col, "is", null)` — the only negated shape used here.
      this.notNullFilters.push(col);
      return this;
    }
    order() {
      return this;
    }
    maybeSingle() {
      this.wantSingle = true;
      return this;
    }
    then(resolve: (v: { data: unknown; error: unknown }) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve(this.run()).then(resolve, reject);
    }
    private match(r: Row) {
      return (
        this.filters.every(([c, v]) => r[c] === v) &&
        this.inFilters.every(([c, vals]) => vals.includes(r[c])) &&
        this.nullFilters.every((c) => r[c] == null) &&
        this.notNullFilters.every((c) => r[c] != null)
      );
    }
    private run(): { data: unknown; error: unknown } {
      const t = db[this.table];
      if (this.op === "delete") {
        db[this.table] = t.filter((r) => !this.match(r));
        return { data: null, error: null };
      }
      const matched = t.filter((r) => this.match(r));
      return { data: this.wantSingle ? matched[0] ?? null : matched, error: null };
    }
  }
  return { db, client: { from: (table: string) => new Builder(table) } };
});

vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => store.client }));

const deleteBuyerStripeCustomer = vi.fn(async (..._a: unknown[]) => {});
vi.mock("./payment-methods.server", () => ({ deleteBuyerStripeCustomer: (...a: unknown[]) => deleteBuyerStripeCustomer(...a) }));

// eslint-disable-next-line import/first -- import must follow vi.mock so the fakes register first
import { listBuyerOrders, listBuyerAddresses, deleteBuyerAccount, getBuyerEmail } from "./account.server";

beforeEach(() => {
  store.db.buyer_dim = [{ id: "buyer-1", shop_id: "shop-1", email_normalized: "casey@shop.com", stripe_customer_id: "cus_1" }];
  store.db.buyer_address = [];
  store.db.orders = [];
  store.db.order_fulfillment = [];
  deleteBuyerStripeCustomer.mockClear();
});

describe("listBuyerOrders", () => {
  it("returns this buyer's orders at this shop, mapped to a PII-free summary", async () => {
    store.db.orders.push(
      { id: "o1", shop_id: "shop-1", buyer_id: "buyer-1", state: "paid", financial_status: "paid", total_cents: 4957, currency: "usd", created_at: "2026-07-01T00:00:00Z", confirmation_token: "tok1" },
      { id: "o2", shop_id: "shop-1", buyer_id: "buyer-2", state: "paid", financial_status: "paid", total_cents: 100, currency: "usd", created_at: "2026-07-02T00:00:00Z", confirmation_token: "tok2" },
    );
    const orders = await listBuyerOrders("shop-1", "buyer-1");
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ orderId: "o1", state: "paid", totalCents: 4957, confirmationToken: "tok1" });
  });

  it("excludes abandoned checkout_pending (and cart) orders so they don't show as 'Payment processing' forever", async () => {
    store.db.orders.push(
      { id: "op", shop_id: "shop-1", buyer_id: "buyer-1", state: "checkout_pending", financial_status: "pending", total_cents: 2500, currency: "usd", created_at: "2026-07-02T00:00:00Z", confirmation_token: "tokp" },
      { id: "ok", shop_id: "shop-1", buyer_id: "buyer-1", state: "paid", financial_status: "paid", total_cents: 4957, currency: "usd", created_at: "2026-07-01T00:00:00Z", confirmation_token: "tok1" },
      { id: "opr", shop_id: "shop-1", buyer_id: "buyer-1", state: "partially_refunded", financial_status: "partially_refunded", total_cents: 3000, currency: "usd", created_at: "2026-07-03T00:00:00Z", confirmation_token: "tokr" },
    );
    const orders = await listBuyerOrders("shop-1", "buyer-1");
    // The abandoned checkout is gone; the paid + partially_refunded orders remain.
    expect(orders.map((o) => o.orderId).sort()).toEqual(["ok", "opr"]);
  });

  it("attaches the latest fulfillment tracking to shipped orders (null when none recorded)", async () => {
    store.db.orders.push(
      { id: "o1", shop_id: "shop-1", buyer_id: "buyer-1", state: "fulfilled", financial_status: "paid", total_cents: 4957, currency: "usd", created_at: "2026-07-01T00:00:00Z", confirmation_token: "tok1" },
      { id: "o2", shop_id: "shop-1", buyer_id: "buyer-1", state: "paid", financial_status: "paid", total_cents: 100, currency: "usd", created_at: "2026-07-02T00:00:00Z", confirmation_token: "tok2" },
    );
    store.db.order_fulfillment.push(
      { id: "f1", shop_id: "shop-1", order_id: "o1", tracking_number: "9400111899220001", carrier: "USPS", created_at: "2026-07-03T00:00:00Z" },
      { id: "f0", shop_id: "shop-1", order_id: "o1", tracking_number: null, carrier: null, created_at: "2026-07-02T00:00:00Z" },
    );
    const orders = await listBuyerOrders("shop-1", "buyer-1");
    const shipped = orders.find((o) => o.orderId === "o1");
    const unshipped = orders.find((o) => o.orderId === "o2");
    expect(shipped).toMatchObject({ trackingNumber: "9400111899220001", trackingCarrier: "USPS" });
    expect(unshipped).toMatchObject({ trackingNumber: null, trackingCarrier: null });
  });
});

describe("listBuyerAddresses / getBuyerEmail", () => {
  it("lists a buyer's addresses and reads their email", async () => {
    store.db.buyer_address.push({ id: "a1", shop_id: "shop-1", buyer_id: "buyer-1", kind: "shipping", line1: "1 Main", country: "US", is_default: true });
    expect(await listBuyerAddresses("shop-1", "buyer-1")).toHaveLength(1);
    expect(await getBuyerEmail("shop-1", "buyer-1")).toBe("casey@shop.com");
  });
});

describe("deleteBuyerAccount (PII/warehouse split)", () => {
  it("detaches Stripe cards, deletes the buyer_dim row, and NEVER touches warehouse order_fact", async () => {
    // A warehouse fact table is deliberately NOT reachable by the deletion — model it as absent
    // from the buyer store; deletion must only remove buyer_dim (its FKs cascade the buyer_* rows).
    await deleteBuyerAccount("shop-1", "buyer-1");
    expect(deleteBuyerStripeCustomer).toHaveBeenCalledWith("shop-1", "buyer-1");
    expect(store.db.buyer_dim.find((r) => r.id === "buyer-1")).toBeUndefined();
  });

  it("deletes the Stripe customer BEFORE the buyer row (so the customer id is still readable)", async () => {
    const order: string[] = [];
    deleteBuyerStripeCustomer.mockImplementationOnce(async () => {
      order.push(`stripe:${store.db.buyer_dim.length}`); // buyer row still present here
    });
    await deleteBuyerAccount("shop-1", "buyer-1");
    expect(order[0]).toBe("stripe:1"); // buyer_dim still had the row when Stripe deletion ran
    expect(store.db.buyer_dim).toHaveLength(0);
  });
});
