import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory stand-in for the tables listDraftCarts / listAbandonedCheckouts touch. Models the
// real PostgREST/Postgres null-comparison gotcha the task brief calls out: `.neq(col, val)`
// evaluates `col <> val` in SQL, which is NULL (not TRUE) when col IS NULL — so a naive `.neq`
// silently drops null-valued rows. `.or("col.is.null,col.neq.val")` is the null-safe form and is
// modeled here as an OR of its comma-separated `col.op.val` clauses.
type Row = Record<string, any>;

const store = vi.hoisted(() => {
  const db: Record<string, Row[]> = { cart: [], cart_line: [], orders: [], buyer_dim: [] };

  class Builder {
    private cols = "";
    private filters: Array<[string, unknown]> = [];
    private neqFilters: Array<[string, unknown]> = [];
    private ltFilters: Array<[string, unknown]> = [];
    private inFilters: Array<[string, unknown[]]> = [];
    private orExpr: string | null = null;
    private orderBy: { col: string; ascending: boolean } | null = null;
    private limitN: number | null = null;
    private readonly table: string;
    constructor(table: string) {
      this.table = table;
    }
    select(cols = "") {
      this.cols = cols;
      return this;
    }
    eq(col: string, val: unknown) {
      this.filters.push([col, val]);
      return this;
    }
    neq(col: string, val: unknown) {
      this.neqFilters.push([col, val]);
      return this;
    }
    lt(col: string, val: unknown) {
      this.ltFilters.push([col, val]);
      return this;
    }
    in(col: string, vals: unknown[]) {
      this.inFilters.push([col, vals]);
      return this;
    }
    or(expr: string) {
      this.orExpr = expr;
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
    then(resolve: (v: { data: unknown; error: unknown }) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve(this.run()).then(resolve, reject);
    }
    private matchesOrClause(row: Row, clause: string): boolean {
      const m = clause.match(/^([a-zA-Z_]+)\.(is|neq|eq|gte)\.(.*)$/);
      if (!m) throw new Error(`unrecognized or() clause shape, update this mock: ${clause}`);
      const [, col, op, rawVal] = m;
      const val = row[col];
      if (op === "is") return rawVal === "null" ? val === null || val === undefined : val === rawVal;
      // NULL-safe: null/undefined never satisfies neq/eq/gte, mirroring real SQL comparison.
      if (val === null || val === undefined) return false;
      if (op === "neq") return val !== rawVal;
      if (op === "eq") return String(val) === rawVal;
      if (op === "gte") return val >= rawVal;
      return false;
    }
    private matchesOr(row: Row): boolean {
      if (!this.orExpr) return true;
      return this.orExpr.split(",").some((clause) => this.matchesOrClause(row, clause));
    }
    private run() {
      let rows = db[this.table].filter(
        (r) =>
          this.filters.every(([c, v]) => r[c] === v) &&
          // NULL-safe .neq, matching real PostgREST: a null column value never satisfies <>.
          this.neqFilters.every(([c, v]) => r[c] != null && r[c] !== v) &&
          this.ltFilters.every(([c, v]) => r[c] < (v as string)) &&
          this.inFilters.every(([c, vs]) => vs.includes(r[c])) &&
          this.matchesOr(r),
      );
      if (this.orderBy) {
        const { col, ascending } = this.orderBy;
        rows = [...rows].sort((a, b) => {
          const av = a[col];
          const bv = b[col];
          if (av === bv) return 0;
          const cmp = av > bv ? 1 : -1;
          return ascending ? cmp : -cmp;
        });
      }
      if (this.limitN != null) rows = rows.slice(0, this.limitN);
      if (this.table === "cart" && this.cols.includes("cart_line(")) {
        rows = rows.map((r) => ({ ...r, cart_line: db.cart_line.filter((l) => l.cart_id === r.id) }));
      }
      return { data: rows, error: null };
    }
  }

  return { db, client: { from: (table: string) => new Builder(table) } };
});

vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => store.client }));
vi.mock("./checkout.server", () => ({ formatOrderRef: (id: string) => `#${id}` }));

// eslint-disable-next-line import/first -- imports must follow vi.mock so the fakes register first
import { listDraftCarts, listAbandonedCheckouts } from "./list.server";

const NOW = new Date("2026-07-09T12:00:00.000Z");
const STALE_2H = new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString();

beforeEach(() => {
  for (const k of Object.keys(store.db)) store.db[k].length = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

describe("listDraftCarts (merchant_draft exclusion)", () => {
  function seedCart(id: string, origin: string | null | undefined) {
    const row: Row = { id, shop_id: "shop-1", buyer_id: null, state: "cart", created_at: NOW.toISOString() };
    if (origin !== undefined) row.origin = origin;
    store.db.cart.push(row);
    store.db.cart_line.push({ cart_id: id, quantity: 1, unit_price_cents: 500, currency: "usd" });
  }

  it("still lists a cart whose origin is NULL — the .or() form must not drop it like a naive .neq would", async () => {
    seedCart("cart-null", null);
    const rows = await listDraftCarts("shop-1");
    expect(rows.map((r) => r.id)).toEqual(["cart-null"]);
  });

  it("lists a cart with no origin column value at all (undefined) the same as NULL", async () => {
    seedCart("cart-undef", undefined);
    const rows = await listDraftCarts("shop-1");
    expect(rows.map((r) => r.id)).toEqual(["cart-undef"]);
  });

  it("excludes a cart whose origin is merchant_draft", async () => {
    seedCart("cart-draft", "merchant_draft");
    const rows = await listDraftCarts("shop-1");
    expect(rows).toEqual([]);
  });

  it("lists a cart with a non-merchant_draft origin", async () => {
    seedCart("cart-other", "storefront");
    const rows = await listDraftCarts("shop-1");
    expect(rows.map((r) => r.id)).toEqual(["cart-other"]);
  });
});

describe("listAbandonedCheckouts (channel exclusions)", () => {
  function seedOrder(id: string, channel: string, createdAt: string) {
    store.db.orders.push({
      id, shop_id: "shop-1", buyer_id: null, state: "checkout_pending", total_cents: 1000, currency: "usd",
      created_at: createdAt, channel,
    });
  }

  it("excludes a stale channel='invoice' order — hosted invoice checkouts age out through their own path", async () => {
    seedOrder("order-invoice", "invoice", STALE_2H);
    const rows = await listAbandonedCheckouts("shop-1");
    expect(rows).toEqual([]);
  });

  it("excludes a stale channel='test' go-live probe order, same as the Orders list", async () => {
    seedOrder("order-test", "test", STALE_2H);
    const rows = await listAbandonedCheckouts("shop-1");
    expect(rows).toEqual([]);
  });

  it("still lists a stale channel='storefront' order", async () => {
    seedOrder("order-storefront", "storefront", STALE_2H);
    const rows = await listAbandonedCheckouts("shop-1");
    expect(rows.map((r) => r.id)).toEqual(["order-storefront"]);
  });
});
