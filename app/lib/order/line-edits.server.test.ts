import { describe, it, expect, beforeEach, vi } from "vitest";

const store = vi.hoisted(() => {
  type Row = Record<string, any>;
  const db: Record<string, Row[]> = { order_line: [], order_line_edit: [] };

  class Builder {
    private filters: Array<[string, unknown]> = [];
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
    then(resolve: (v: { data: unknown; error: unknown }) => unknown, reject?: (e: unknown) => unknown) {
      const t = db[this.table];
      const matched = t.filter((r) => this.filters.every(([c, v]) => r[c] === v));
      return Promise.resolve({ data: matched, error: null }).then(resolve, reject);
    }
  }

  const client = { from: (table: string) => new Builder(table) };
  return { db, client };
});

vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => store.client }));

// eslint-disable-next-line import/first -- imports must follow vi.mock so the fake registers first
import { effectiveLineQuantities } from "./line-edits.server";

beforeEach(() => {
  store.db.order_line.length = 0;
  store.db.order_line_edit.length = 0;
});

describe("effectiveLineQuantities", () => {
  it("no edits: effective equals the snapshot, reduced is 0", async () => {
    store.db.order_line.push({ id: "line-1", shop_id: "shop-1", order_id: "order-1", quantity: 5 });
    const map = await effectiveLineQuantities("shop-1", "order-1");
    expect(map.get("line-1")).toEqual({ snapshot: 5, reduced: 0, effective: 5 });
  });

  it("one edit: effective is the edit's new_quantity, reduced is the delta", async () => {
    store.db.order_line.push({ id: "line-1", shop_id: "shop-1", order_id: "order-1", quantity: 5 });
    store.db.order_line_edit.push({
      id: "edit-1",
      shop_id: "shop-1",
      order_id: "order-1",
      order_line_id: "line-1",
      new_quantity: 3,
      created_at: "2026-07-01T00:00:00.000Z",
    });
    const map = await effectiveLineQuantities("shop-1", "order-1");
    expect(map.get("line-1")).toEqual({ snapshot: 5, reduced: 2, effective: 3 });
  });

  it("chained edits (5->3 then 3->1): effective is the LATEST edit's new_quantity, not a sum of deltas", async () => {
    store.db.order_line.push({ id: "line-1", shop_id: "shop-1", order_id: "order-1", quantity: 5 });
    store.db.order_line_edit.push(
      {
        id: "edit-1",
        shop_id: "shop-1",
        order_id: "order-1",
        order_line_id: "line-1",
        old_quantity: 5,
        new_quantity: 3,
        created_at: "2026-07-01T00:00:00.000Z",
      },
      {
        id: "edit-2",
        shop_id: "shop-1",
        order_id: "order-1",
        order_line_id: "line-1",
        old_quantity: 3,
        new_quantity: 1,
        created_at: "2026-07-02T00:00:00.000Z",
      },
    );
    const map = await effectiveLineQuantities("shop-1", "order-1");
    // reduced is against the ORIGINAL snapshot (5), not against the intermediate 3.
    expect(map.get("line-1")).toEqual({ snapshot: 5, reduced: 4, effective: 1 });
  });

  it("out-of-order rows: still picks the edit with the latest created_at, regardless of array order", async () => {
    store.db.order_line.push({ id: "line-1", shop_id: "shop-1", order_id: "order-1", quantity: 10 });
    store.db.order_line_edit.push(
      {
        id: "edit-2",
        shop_id: "shop-1",
        order_id: "order-1",
        order_line_id: "line-1",
        new_quantity: 4,
        created_at: "2026-07-02T00:00:00.000Z",
      },
      {
        id: "edit-1",
        shop_id: "shop-1",
        order_id: "order-1",
        order_line_id: "line-1",
        new_quantity: 7,
        created_at: "2026-07-01T00:00:00.000Z",
      },
    );
    const map = await effectiveLineQuantities("shop-1", "order-1");
    expect(map.get("line-1")?.effective).toBe(4);
  });

  it("multiple lines, only one edited: unedited lines pass through untouched", async () => {
    store.db.order_line.push(
      { id: "line-1", shop_id: "shop-1", order_id: "order-1", quantity: 5 },
      { id: "line-2", shop_id: "shop-1", order_id: "order-1", quantity: 2 },
    );
    store.db.order_line_edit.push({
      id: "edit-1",
      shop_id: "shop-1",
      order_id: "order-1",
      order_line_id: "line-1",
      new_quantity: 2,
      created_at: "2026-07-01T00:00:00.000Z",
    });
    const map = await effectiveLineQuantities("shop-1", "order-1");
    expect(map.get("line-1")).toEqual({ snapshot: 5, reduced: 3, effective: 2 });
    expect(map.get("line-2")).toEqual({ snapshot: 2, reduced: 0, effective: 2 });
  });

  it("scopes to shop_id + order_id: a same-id edit under a different order is ignored", async () => {
    store.db.order_line.push({ id: "line-1", shop_id: "shop-1", order_id: "order-1", quantity: 5 });
    store.db.order_line_edit.push({
      id: "edit-1",
      shop_id: "shop-1",
      order_id: "order-OTHER",
      order_line_id: "line-1",
      new_quantity: 1,
      created_at: "2026-07-01T00:00:00.000Z",
    });
    const map = await effectiveLineQuantities("shop-1", "order-1");
    expect(map.get("line-1")).toEqual({ snapshot: 5, reduced: 0, effective: 5 });
  });
});
