import { describe, it, expect, beforeEach, vi } from "vitest";

const store = vi.hoisted(() => {
  type Row = Record<string, any>;
  const db: Record<string, Row[]> = { order_line: [], variant_dim: [], location_dim: [], inventory_reservation: [] };
  const rpc = vi.fn(async () => ({ data: null, error: null }));
  class Builder {
    private filters: Array<[string, unknown]> = [];
    private inFilters: Array<[string, unknown[]]> = [];
    private ord: string | null = null;
    private lim = 0;
    private readonly table: string;
    constructor(table: string) {
      this.table = table;
    }
    select(_c?: string) { return this; }
    insert(p: Row | Row[]) { const rows = Array.isArray(p) ? p : [p]; rows.forEach((r) => db[this.table].push({ id: `${this.table}-${db[this.table].length + 1}`, ...r })); return this; }
    eq(c: string, v: unknown) { this.filters.push([c, v]); return this; }
    in(c: string, v: unknown[]) { this.inFilters.push([c, v]); return this; }
    order(c: string, _o?: unknown) { this.ord = c; return this; }
    limit(n: number) { this.lim = n; return this; }
    single() { return this.then((r: any) => ({ data: (r.data as Row[])[0] ?? null, error: null })); }
    then(res: (v: { data: unknown; error: unknown }) => unknown, rej?: (e: unknown) => unknown) {
      let rows = db[this.table].filter((r) => this.filters.every(([c, v]) => r[c] === v) && this.inFilters.every(([c, vs]) => vs.includes(r[c])));
      if (this.lim) rows = rows.slice(0, this.lim);
      return Promise.resolve({ data: rows, error: null }).then(res, rej);
    }
  }
  return { db, rpc, client: { from: (t: string) => new Builder(t), rpc } };
});

vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => store.client }));
vi.mock("~/lib/inventory/project-level-fact.server", () => ({ projectLevelFact: vi.fn(async () => {}) }));

// eslint-disable-next-line import/first -- imports must follow vi.mock so the fakes register first
import { restockOrderLines } from "../engine.server";

describe("restockOrderLines", () => {
  beforeEach(() => {
    for (const k of Object.keys(store.db)) store.db[k].length = 0;
    store.rpc.mockClear();
    store.db.location_dim.push({ id: "loc-1", shop_id: "shop-1", priority: 0, created_at: "2026-01-01" });
    store.db.order_line.push(
      { id: "ol-1", shop_id: "shop-1", order_id: "o-1", variant_id: "v-tracked", quantity: 2 },
      { id: "ol-2", shop_id: "shop-1", order_id: "o-1", variant_id: "v-untracked", quantity: 1 },
    );
    store.db.variant_dim.push(
      { id: "v-tracked", shop_id: "shop-1", inventory_tracked: true },
      { id: "v-untracked", shop_id: "shop-1", inventory_tracked: false },
    );
  });

  it("restocks only tracked lines, keyed idempotently per (order, variant)", async () => {
    const res = await restockOrderLines("shop-1", "o-1", "refund");
    expect(res.restockedLines).toBe(1);
    expect(res.failedVariantIds).toEqual([]);
    expect(store.rpc).toHaveBeenCalledTimes(1);
    expect(store.rpc).toHaveBeenCalledWith("inventory_restock", {
      p_shop_id: "shop-1", p_variant_id: "v-tracked", p_location_id: "loc-1",
      p_qty: 2, p_idempotency_key: "restock:o-1:v-tracked", p_reason: "refund",
    });
  });

  it("returns 0 and calls nothing when no line is tracked", async () => {
    store.db.variant_dim.find((v) => v.id === "v-tracked")!.inventory_tracked = false;
    const res = await restockOrderLines("shop-1", "o-1", "refund");
    expect(res.restockedLines).toBe(0);
    expect(res.failedVariantIds).toEqual([]);
    expect(store.rpc).not.toHaveBeenCalled();
  });

  it("continues past a failed variant's RPC instead of throwing, reporting partial progress", async () => {
    // Two tracked variants; the RPC fails for v-bad but succeeds for v-good.
    store.db.order_line.length = 0;
    store.db.order_line.push(
      { id: "ol-1", shop_id: "shop-1", order_id: "o-1", variant_id: "v-good", quantity: 1 },
      { id: "ol-2", shop_id: "shop-1", order_id: "o-1", variant_id: "v-bad", quantity: 1 },
    );
    store.db.variant_dim.length = 0;
    store.db.variant_dim.push(
      { id: "v-good", shop_id: "shop-1", inventory_tracked: true },
      { id: "v-bad", shop_id: "shop-1", inventory_tracked: true },
    );
    (store.rpc as unknown as { mockImplementation: (fn: (...args: unknown[]) => unknown) => void }).mockImplementation(
      (...args: unknown[]) => {
        const rpcArgs = args[1] as Record<string, unknown>;
        if (rpcArgs.p_variant_id === "v-bad") return Promise.resolve({ data: null, error: { message: "deadlock" } });
        return Promise.resolve({ data: null, error: null });
      },
    );
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await restockOrderLines("shop-1", "o-1", "refund");
      expect(res).toEqual({ restockedLines: 1, failedVariantIds: ["v-bad"] });
      expect(consoleErr).toHaveBeenCalled();
    } finally {
      consoleErr.mockRestore();
    }
  });
});
