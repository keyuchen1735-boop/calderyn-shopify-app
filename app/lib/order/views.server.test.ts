import { describe, it, expect } from "vitest";
import {
  listOrderViews,
  createOrderView,
  deleteOrderView,
  TooManyViewsError,
  ViewNameTakenError,
  MAX_ORDER_VIEWS,
} from "./views.server";

// Minimal in-memory Supabase stand-in for order_view's CRUD (select/eq/order chains + insert +
// delete), same Builder shape/convention as notes.server.test.ts / dashboard.api.orders.detail.test.ts,
// extended with .order() (listOrderViews sorts by position then created_at) and a (shop_id, name)
// unique-constraint simulation on insert (so the 23505 mapping is exercised for real).
type Row = Record<string, any>;

function makeStore() {
  const rows: Row[] = [];
  let seq = 0;

  class Builder {
    private op: "select" | "insert" | "delete" = "select";
    private payload: Row = {};
    private filters: Array<[string, unknown]> = [];
    private sorts: Array<[string, boolean]> = [];
    private wantSingle = false;

    select(_cols?: string) {
      return this;
    }
    eq(col: string, val: unknown) {
      this.filters.push([col, val]);
      return this;
    }
    order(col: string, opts: { ascending: boolean }) {
      this.sorts.push([col, opts.ascending]);
      return this;
    }
    insert(payload: Row) {
      this.op = "insert";
      this.payload = payload;
      return this;
    }
    delete() {
      this.op = "delete";
      return this;
    }
    single() {
      this.wantSingle = true;
      return this;
    }
    then(resolve: (v: { data: unknown; error: unknown }) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve(this.run()).then(resolve, reject);
    }
    private matches(r: Row): boolean {
      return this.filters.every(([c, v]) => r[c] === v);
    }
    private run(): { data: unknown; error: unknown } {
      if (this.op === "insert") {
        const dup = rows.some((r) => r.shop_id === this.payload.shop_id && r.name === this.payload.name);
        if (dup) {
          return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
        }
        seq += 1;
        const row: Row = {
          id: `view-${seq}`,
          position: 0,
          created_at: new Date(2026, 0, seq).toISOString(),
          ...this.payload,
        };
        rows.push(row);
        return { data: row, error: null };
      }
      if (this.op === "delete") {
        const matched = rows.filter((r) => this.matches(r));
        for (const r of matched) rows.splice(rows.indexOf(r), 1);
        return { data: matched, error: null };
      }
      let result = rows.filter((r) => this.matches(r));
      // Apply order() calls least-significant-first: Array#sort is stable, so sorting by the
      // last-registered column first and working back to the first preserves each earlier
      // column as the dominant key while later columns settle ties, matching Postgres'
      // multi-column ORDER BY semantics for chained .order() calls.
      for (const [col, asc] of [...this.sorts].reverse()) {
        result = [...result].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
      }
      if (this.wantSingle) return { data: result[0] ?? null, error: null };
      return { data: result, error: null };
    }
  }

  return { rows, client: { from: (_table: string) => new Builder() } };
}

describe("listOrderViews", () => {
  it("lists a shop's views ordered by position then created_at", async () => {
    const store = makeStore();
    store.rows.push(
      { id: "v1", shop_id: "shop-1", name: "B", filters: {}, position: 1, created_at: "2026-01-01T00:00:00Z" },
      { id: "v2", shop_id: "shop-1", name: "A", filters: { search: "x" }, position: 0, created_at: "2026-01-02T00:00:00Z" },
      { id: "v3", shop_id: "shop-2", name: "Other shop", filters: {}, position: 0, created_at: "2026-01-01T00:00:00Z" },
    );
    const result = await listOrderViews("shop-1", store.client as any);
    expect(result).toEqual([
      { id: "v2", name: "A", filters: { search: "x" }, position: 0 },
      { id: "v1", name: "B", filters: {}, position: 1 },
    ]);
  });

  it("returns an empty array when the shop has no saved views", async () => {
    const store = makeStore();
    expect(await listOrderViews("shop-1", store.client as any)).toEqual([]);
  });
});

describe("createOrderView", () => {
  it("creates a view and returns it mapped", async () => {
    const store = makeStore();
    const result = await createOrderView("shop-1", "My VIP orders", { search: "vip" }, store.client as any);
    expect(result).toMatchObject({ name: "My VIP orders", filters: { search: "vip" }, position: 0 });
    expect(typeof result.id).toBe("string");
    expect(store.rows).toHaveLength(1);
  });

  it("throws ViewNameTakenError on a duplicate (shop_id, name)", async () => {
    const store = makeStore();
    await createOrderView("shop-1", "Dup", {}, store.client as any);
    await expect(createOrderView("shop-1", "Dup", {}, store.client as any)).rejects.toBeInstanceOf(
      ViewNameTakenError,
    );
    expect(store.rows).toHaveLength(1);
  });

  it("allows the same name across different shops", async () => {
    const store = makeStore();
    await createOrderView("shop-1", "Same name", {}, store.client as any);
    await expect(createOrderView("shop-2", "Same name", {}, store.client as any)).resolves.toMatchObject({
      name: "Same name",
    });
  });

  it("throws TooManyViewsError at MAX_ORDER_VIEWS for one shop, without inserting", async () => {
    const store = makeStore();
    for (let i = 0; i < MAX_ORDER_VIEWS; i++) {
      store.rows.push({ id: `v${i}`, shop_id: "shop-1", name: `View ${i}`, filters: {}, position: i, created_at: "2026-01-01T00:00:00Z" });
    }
    await expect(createOrderView("shop-1", "One too many", {}, store.client as any)).rejects.toBeInstanceOf(
      TooManyViewsError,
    );
    expect(store.rows).toHaveLength(MAX_ORDER_VIEWS);
  });
});

describe("deleteOrderView", () => {
  it("deletes a matching shop-scoped row and returns true", async () => {
    const store = makeStore();
    store.rows.push({ id: "v1", shop_id: "shop-1", name: "A", filters: {}, position: 0 });
    expect(await deleteOrderView("shop-1", "v1", store.client as any)).toBe(true);
    expect(store.rows).toHaveLength(0);
  });

  it("returns false for an unknown id, and for another shop's view (no delete)", async () => {
    const store = makeStore();
    store.rows.push({ id: "v1", shop_id: "shop-2", name: "A", filters: {}, position: 0 });
    expect(await deleteOrderView("shop-1", "v1", store.client as any)).toBe(false);
    expect(await deleteOrderView("shop-1", "nope", store.client as any)).toBe(false);
    expect(store.rows).toHaveLength(1);
  });
});
