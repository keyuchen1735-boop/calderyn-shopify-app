import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory stand-in for the orders + audit tables. Enforces the constraints the helper
// relies on so behavior is tested against REAL rules, not bare mocks:
//   - order_state_transition carries a COMPOSITE FK (shop_id, order_id) -> orders(shop_id,
//     id): an audit row can only be written against an order that exists in the SAME shop
//     (cross-tenant guard). transitionOrder reads the order first, so this also backstops
//     the "order not found" path.
//   - flags.removeOrderAfterAudit simulates a concurrent delete that cascades the order (and
//     its just-inserted audit row) away between the audit insert and the state UPDATE, so the
//     UPDATE affects 0 rows — exercising transitionOrder's rowcount guard.
const store = vi.hoisted(() => {
  type Row = Record<string, any>;
  const db: Record<string, Row[]> = { orders: [], order_state_transition: [] };
  const flags = { removeOrderAfterAudit: false };

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
        if (this.table === "order_state_transition") {
          const parent = db.orders.find(
            (o) => o.shop_id === this.payload.shop_id && o.id === this.payload.order_id,
          );
          if (!parent) {
            return { data: null, error: { message: "composite FK (shop_id, order_id) -> orders violated" } };
          }
        }
        const row: Row = {
          id: `${this.table}-${t.length + 1}`,
          occurred_at: new Date().toISOString(),
          ...this.payload,
        };
        t.push(row);
        // Simulate a concurrent delete landing right after the audit row is written.
        if (this.table === "order_state_transition" && flags.removeOrderAfterAudit) {
          const idx = db.orders.findIndex(
            (o) => o.shop_id === this.payload.shop_id && o.id === this.payload.order_id,
          );
          if (idx >= 0) db.orders.splice(idx, 1);
        }
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
  return { db, flags, client };
});

vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => store.client }));

// eslint-disable-next-line import/first -- import must follow vi.mock so the supabase fake is registered first
import { transitionOrder, reserveInventory } from "./order.server";

function seedOrder(shopId: string, id: string, state: string) {
  store.db.orders.push({ id, shop_id: shopId, state });
}

beforeEach(() => {
  store.db.orders.length = 0;
  store.db.order_state_transition.length = 0;
  store.flags.removeOrderAfterAudit = false;
});

describe("transitionOrder", () => {
  it("applies a legal transition: updates state AND writes one audit row", async () => {
    seedOrder("shop-1", "ord-1", "checkout_pending");
    const t = await transitionOrder("shop-1", "ord-1", "paid", "stripe webhook");

    expect(t).toMatchObject({ orderId: "ord-1", fromState: "checkout_pending", toState: "paid", reason: "stripe webhook" });
    expect(store.db.orders[0].state).toBe("paid"); // state advanced
    expect(store.db.order_state_transition).toHaveLength(1); // audit row written
    expect(store.db.order_state_transition[0]).toMatchObject({
      shop_id: "shop-1",
      order_id: "ord-1",
      from_state: "checkout_pending",
      to_state: "paid",
      reason: "stripe webhook",
    });
  });

  it("writes one audit row per transition across a multi-step lifecycle", async () => {
    seedOrder("shop-1", "ord-1", "checkout_pending");
    await transitionOrder("shop-1", "ord-1", "paid");
    await transitionOrder("shop-1", "ord-1", "fulfilled");
    expect(store.db.orders[0].state).toBe("fulfilled");
    expect(store.db.order_state_transition).toHaveLength(2);
    expect(store.db.order_state_transition.map((r) => r.to_state)).toEqual(["paid", "fulfilled"]);
  });

  it("rejects an illegal transition WITHOUT mutating state or writing an audit row", async () => {
    seedOrder("shop-1", "ord-1", "checkout_pending");
    await expect(transitionOrder("shop-1", "ord-1", "fulfilled")).rejects.toThrow(/illegal order transition/);
    expect(store.db.orders[0].state).toBe("checkout_pending"); // unchanged
    expect(store.db.order_state_transition).toHaveLength(0); // nothing written
  });

  it("rejects a move out of a terminal state", async () => {
    seedOrder("shop-1", "ord-1", "refunded");
    await expect(transitionOrder("shop-1", "ord-1", "paid")).rejects.toThrow(/illegal order transition/);
    expect(store.db.order_state_transition).toHaveLength(0);
  });

  it("throws when the order does not exist for this shop (never creates one)", async () => {
    await expect(transitionOrder("shop-1", "ghost", "paid")).rejects.toThrow(/not found for shop/);
    expect(store.db.orders).toHaveLength(0);
  });

  it("does not let one shop transition another shop's order", async () => {
    seedOrder("shop-A", "ord-1", "checkout_pending");
    // shop-B can't see shop-A's order -> not found, no write.
    await expect(transitionOrder("shop-B", "ord-1", "paid")).rejects.toThrow(/not found for shop/);
    expect(store.db.orders[0].state).toBe("checkout_pending");
  });

  it("throws when the state UPDATE affects 0 rows (order vanished between read and update)", async () => {
    seedOrder("shop-1", "ord-1", "checkout_pending");
    store.flags.removeOrderAfterAudit = true; // concurrent delete after the audit insert
    await expect(transitionOrder("shop-1", "ord-1", "paid")).rejects.toThrow(/expected exactly 1|changed under us/);
    expect(store.db.orders).toHaveLength(0); // order is gone — no fake success reported
  });
});

describe("reserveInventory", () => {
  it("is a visible no-op stub: returns { reserved: false, reason: 'stub' }", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await reserveInventory("shop-1", [{ variantId: "v-tee-s", quantity: 2 }]);
    expect(result).toEqual({ reserved: false, reason: "stub" });
    // The non-enforcement is logged so the checkout path can record that oversell is possible (rule 12).
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/NOT enforced \(stub\)/));
    warn.mockRestore();
  });
});
