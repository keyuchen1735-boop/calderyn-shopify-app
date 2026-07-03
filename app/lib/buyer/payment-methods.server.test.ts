import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory buyer_dim + buyer_payment_method with the shapes the saved-card helpers use.
const store = vi.hoisted(() => {
  type Row = Record<string, any>;
  const db: Record<string, Row[]> = { buyer_dim: [], buyer_payment_method: [] };

  class Builder {
    private op: "select" | "insert" | "update" | "upsert" = "select";
    private payload: Row = {};
    private vals: Row = {};
    private onConflict: string[] = [];
    private filters: Array<[string, unknown]> = [];
    private nullFilters: string[] = [];
    private wantSingle = false;
    private readonly table: string;
    constructor(table: string) {
      this.table = table;
    }
    upsert(payload: Row, opts?: { onConflict?: string }) {
      this.op = "upsert";
      this.payload = payload;
      this.onConflict = (opts?.onConflict ?? "").split(",").map((c) => c.trim()).filter(Boolean);
      return this;
    }
    update(vals: Row) {
      this.op = "update";
      this.vals = vals;
      return this;
    }
    select(_c?: string) {
      return this;
    }
    eq(col: string, val: unknown) {
      this.filters.push([col, val]);
      return this;
    }
    is(col: string, _val: null) {
      this.nullFilters.push(col);
      return this;
    }
    order() {
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
    private match(r: Row) {
      return this.filters.every(([c, v]) => r[c] === v) && this.nullFilters.every((c) => r[c] == null);
    }
    private wrap(rows: Row[]) {
      return { data: this.wantSingle ? rows[0] ?? null : rows, error: null };
    }
    private run(): { data: unknown; error: unknown } {
      const t = db[this.table];
      if (this.op === "upsert") {
        const existing = t.find((r) => this.onConflict.every((c) => r[c] === this.payload[c]));
        if (existing) {
          Object.assign(existing, this.payload);
          return this.wrap([existing]);
        }
        const row: Row = { id: `${this.table}-${t.length + 1}`, created_at: new Date().toISOString(), ...this.payload };
        t.push(row);
        return this.wrap([row]);
      }
      if (this.op === "update") {
        const matched = t.filter((r) => this.match(r));
        for (const r of matched) Object.assign(r, this.vals);
        return this.wrap(matched);
      }
      return this.wrap(t.filter((r) => this.match(r)));
    }
  }
  return { db, client: { from: (table: string) => new Builder(table) } };
});

vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => store.client }));

const stripe = vi.hoisted(() => ({
  customers: { create: vi.fn(), del: vi.fn() },
  setupIntents: { create: vi.fn(), retrieve: vi.fn() },
  paymentMethods: { detach: vi.fn() },
}));
vi.mock("~/lib/payments/stripe.server", () => ({ getStripe: () => stripe }));

// eslint-disable-next-line import/first -- import must follow vi.mock so the fakes register first
import {
  ensureBuyerStripeCustomer,
  saveConfirmedCard,
  listSavedCards,
  detachCard,
} from "./payment-methods.server";

beforeEach(() => {
  store.db.buyer_dim = [{ id: "buyer-1", shop_id: "shop-1", email_normalized: "casey@shop.com", stripe_customer_id: null }];
  store.db.buyer_payment_method = [];
  stripe.customers.create.mockReset().mockResolvedValue({ id: "cus_1" });
  stripe.setupIntents.retrieve.mockReset();
  stripe.paymentMethods.detach.mockReset().mockResolvedValue({});
});

describe("ensureBuyerStripeCustomer", () => {
  it("creates a Customer once and caches it on buyer_dim", async () => {
    const id1 = await ensureBuyerStripeCustomer("shop-1", "buyer-1");
    expect(id1).toBe("cus_1");
    expect(store.db.buyer_dim[0].stripe_customer_id).toBe("cus_1");
    const id2 = await ensureBuyerStripeCustomer("shop-1", "buyer-1");
    expect(id2).toBe("cus_1");
    expect(stripe.customers.create).toHaveBeenCalledTimes(1); // reused, not recreated
  });
});

describe("saveConfirmedCard", () => {
  it("persists the display fields for a succeeded SetupIntent owned by the buyer", async () => {
    store.db.buyer_dim[0].stripe_customer_id = "cus_1";
    stripe.setupIntents.retrieve.mockResolvedValue({
      status: "succeeded",
      customer: "cus_1",
      payment_method: { id: "pm_1", card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 } },
    });
    const card = await saveConfirmedCard("shop-1", "buyer-1", "seti_1");
    expect(card).toMatchObject({ brand: "visa", last4: "4242", expMonth: 12, expYear: 2030, stripePaymentMethodId: "pm_1" });
    expect(store.db.buyer_payment_method).toHaveLength(1);
  });

  it("REJECTS a SetupIntent whose Customer is not this buyer's (no card saved)", async () => {
    store.db.buyer_dim[0].stripe_customer_id = "cus_1";
    stripe.setupIntents.retrieve.mockResolvedValue({
      status: "succeeded",
      customer: "cus_someone_else",
      payment_method: { id: "pm_evil", card: { brand: "visa", last4: "0000" } },
    });
    expect(await saveConfirmedCard("shop-1", "buyer-1", "seti_evil")).toBeNull();
    expect(store.db.buyer_payment_method).toHaveLength(0);
  });

  it("returns null for a not-yet-succeeded SetupIntent", async () => {
    store.db.buyer_dim[0].stripe_customer_id = "cus_1";
    stripe.setupIntents.retrieve.mockResolvedValue({ status: "processing", customer: "cus_1", payment_method: null });
    expect(await saveConfirmedCard("shop-1", "buyer-1", "seti_x")).toBeNull();
  });
});

describe("listSavedCards / detachCard", () => {
  it("lists only active cards and detaches in Stripe + soft-deletes on remove", async () => {
    store.db.buyer_payment_method.push(
      { id: "c1", shop_id: "shop-1", buyer_id: "buyer-1", stripe_customer_id: "cus_1", stripe_payment_method_id: "pm_1", brand: "visa", last4: "4242", detached_at: null, created_at: "2026-07-01" },
      { id: "c2", shop_id: "shop-1", buyer_id: "buyer-1", stripe_customer_id: "cus_1", stripe_payment_method_id: "pm_2", brand: "amex", last4: "0005", detached_at: "2026-07-02", created_at: "2026-07-01" },
    );
    expect(await listSavedCards("shop-1", "buyer-1")).toHaveLength(1);

    const ok = await detachCard("shop-1", "buyer-1", "c1");
    expect(ok).toBe(true);
    expect(stripe.paymentMethods.detach).toHaveBeenCalledWith("pm_1");
    expect(store.db.buyer_payment_method.find((r) => r.id === "c1")!.detached_at).not.toBeNull();
    expect(await listSavedCards("shop-1", "buyer-1")).toHaveLength(0);
  });

  it("no-ops (false) when the card is unknown or belongs to another buyer", async () => {
    expect(await detachCard("shop-1", "buyer-1", "missing")).toBe(false);
    expect(stripe.paymentMethods.detach).not.toHaveBeenCalled();
  });
});
