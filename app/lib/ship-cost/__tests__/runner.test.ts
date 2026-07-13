/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory supabase fake */
import { describe, it, expect } from "vitest";
import { runShipCostResolution, rollShipCostIntoSkuPnl } from "../runner.server";
import { DEFAULT_SHIP_RATE_PER_KG_CENTS } from "../model";

// ---------------------------------------------------------------------------
// Minimal in-memory Supabase stub
// ---------------------------------------------------------------------------

interface UpdateRecord {
  table: string;
  payload: Record<string, unknown>;
  filters: Record<string, unknown>;
}

interface RpcRecord {
  fn: string;
  args: Record<string, unknown>;
}

// PostgREST silently truncates an uncapped select at this many rows. The fake
// emulates that default so a query without an explicit cap or .range() loop
// cannot read past it — proving the truncation bug the runner has to defeat.
const POSTGREST_DEFAULT_MAX = 1000;

function makeSupabaseFake(tables: Record<string, any[]>) {
  const updates: UpdateRecord[] = [];
  const rpcs: RpcRecord[] = [];

  function makeChain(table: string, rows: any[]) {
    let filters: Record<string, unknown> = {};
    let selectedRows = rows;
    // null until the caller sets an explicit cap (.limit) or page (.range);
    // when null the read is truncated to POSTGREST_DEFAULT_MAX, like real PostgREST.
    let rangeFrom: number | null = null;
    let rangeTo: number | null = null;
    let explicitLimit: number | null = null;
    const chain: any = {
      select(_cols?: string) {
        return chain;
      },
      eq(col: string, val: unknown) {
        filters = { ...filters, [col]: val };
        selectedRows = selectedRows.filter((r) => r[col] === val);
        return chain;
      },
      in(col: string, vals: unknown[]) {
        // Added for the allocation fence (C6): runner now filters the period query by
        // .in("source", ["upload","typed"]). Apply it as a real filter.
        selectedRows = selectedRows.filter((r) => vals.includes(r[col]));
        return chain;
      },
      not(col: string, _op: string, _val: unknown) {
        // .not("ship_cost_cents", "is", null) → filter out rows where col IS null
        selectedRows = selectedRows.filter((r) => r[col] !== null && r[col] !== undefined);
        return chain;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        const asc = opts?.ascending !== false;
        selectedRows = [...selectedRows].sort((a, b) => {
          if (a[col] < b[col]) return asc ? -1 : 1;
          if (a[col] > b[col]) return asc ? 1 : -1;
          return 0;
        });
        return chain;
      },
      limit(n: number) {
        explicitLimit = n;
        return chain;
      },
      range(from: number, to: number) {
        // PostgREST .range is inclusive on both ends.
        rangeFrom = from;
        rangeTo = to;
        return chain;
      },
      update(payload: Record<string, unknown>) {
        const updateFilters: Record<string, unknown> = {};
        // update chain collects eq filters for assertion but does not enforce them as row guards
        const updateChain: any = {
          eq(col: string, val: unknown) {
            updateFilters[col] = val;
            return updateChain;
          },
          then(cb: (r: { data: null; error: null }) => unknown) {
            updates.push({ table, payload, filters: updateFilters });
            return Promise.resolve(cb({ data: null, error: null }));
          },
        };
        return updateChain;
      },
      then(cb: (r: { data: any[]; error: null }) => unknown) {
        let out: any[];
        if (rangeFrom != null && rangeTo != null) {
          // Range page: inclusive slice; this is how a paginating reader walks
          // past the default truncation ceiling.
          out = selectedRows.slice(rangeFrom, rangeTo + 1);
        } else if (explicitLimit != null) {
          out = selectedRows.slice(0, explicitLimit);
        } else {
          // No explicit cap/page → PostgREST default truncation.
          out = selectedRows.slice(0, POSTGREST_DEFAULT_MAX);
        }
        return Promise.resolve(cb({ data: out, error: null }));
      },
    };
    return chain;
  }

  const sb: any = {
    from(table: string) {
      const rows = tables[table] ?? [];
      return makeChain(table, rows);
    },
    rpc(fn: string, args: Record<string, unknown>) {
      rpcs.push({ fn, args });
      return Promise.resolve({ data: null, error: null });
    },
    _updates: updates,
    _rpcs: rpcs,
  };

  return sb;
}

// The runner writes through set-based RPCs (one round-trip per batch), not one
// PostgREST update per row. These helpers flatten the batched payloads back to
// per-row records for assertion.
function rpcCalls(sb: any, fn: string): RpcRecord[] {
  return sb._rpcs.filter((c: RpcRecord) => c.fn === fn);
}
function rpcRows(sb: any, fn: string): any[] {
  return rpcCalls(sb, fn).flatMap((c: any) => c.args.p_rows as any[]);
}
const orderWrites = (sb: any) => rpcRows(sb, "ship_cost_apply_order_updates");
const pnlWrites = (sb: any) => rpcRows(sb, "ship_cost_apply_sku_pnl_updates");

// ---------------------------------------------------------------------------
// Test 1: period total allocated correctly across 2 orders (grams-weighted)
// ---------------------------------------------------------------------------
describe("runShipCostResolution — period total allocation", () => {
  it("sum of ship_cost_cents writes equals period total; heavier/farther order gets more", async () => {
    const tables: Record<string, any[]> = {
      v_order_ship_features: [
        { id: "o1", shop_id: "shop1", customer_country: "US", grams_sum: 100, item_count: 1, fulfillment_count: 1 },
        { id: "o2", shop_id: "shop1", customer_country: "CA", grams_sum: 300, item_count: 1, fulfillment_count: 1 },
      ],
      shipping_cost_period: [{ shop_id: "shop1", total_cents: 1000, source: "upload" }],
      shipping_invoice_line: [],
      // rollShipCostIntoSkuPnl needs these — empty so it's a no-op
      order_fact: [],
      order_line_fact: [],
      sku_pnl: [],
    };

    const sb = makeSupabaseFake(tables);
    await runShipCostResolution(sb as any, "shop1", { shopCountry: null });

    const writes = orderWrites(sb);
    expect(writes).toHaveLength(2);
    // Writes are batched RPCs, never one PostgREST update per order (the serial
    // per-row loop is what exhausted the cron's 300s ceiling in prod).
    expect(sb._updates.filter((u: UpdateRecord) => u.table === "order_fact")).toHaveLength(0);
    // Every batch carries the tenant fence.
    for (const call of rpcCalls(sb, "ship_cost_apply_order_updates")) {
      expect(call.args.p_shop_id).toBe("shop1");
    }

    const total = writes.reduce((s: number, r: any) => s + (r.ship_cost_cents as number), 0);
    expect(total).toBe(1000);

    const o1 = writes.find((r: any) => r.id === "o1")!;
    const o2 = writes.find((r: any) => r.id === "o2")!;
    // o2 is heavier (300g) so must get more than o1 (100g)
    // (zone multiplier is 1 for both since shopCountry is null → domestic)
    expect(o2.ship_cost_cents as number).toBeGreaterThan(o1.ship_cost_cents as number);
  });
});

// ---------------------------------------------------------------------------
// Test 2: shipping_invoice_line matched to an order → source = actual_invoice
// ---------------------------------------------------------------------------
describe("runShipCostResolution — invoice line takes priority", () => {
  it("matched invoice order gets source=actual_invoice and exact invoice cost_cents", async () => {
    const tables: Record<string, any[]> = {
      v_order_ship_features: [
        { id: "o1", shop_id: "shop1", customer_country: "US", grams_sum: 200, item_count: 2, fulfillment_count: 1 },
      ],
      shipping_cost_period: [{ shop_id: "shop1", total_cents: 5000, source: "upload" }],
      shipping_invoice_line: [
        { shop_id: "shop1", matched_order_id: "o1", cost_cents: 750 },
      ],
      order_fact: [],
      order_line_fact: [],
      sku_pnl: [],
    };

    const sb = makeSupabaseFake(tables);
    await runShipCostResolution(sb as any, "shop1", { shopCountry: null });

    const writes = orderWrites(sb);
    expect(writes).toHaveLength(1);
    expect(writes[0].ship_cost_source).toBe("actual_invoice");
    expect(writes[0].ship_cost_cents).toBe(750);
    expect(writes[0].ship_cost_confidence).toBe("high");
  });
});

// ---------------------------------------------------------------------------
// Test 2b: manual override (from v_order_ship_features) wins, stamps 'manual'
// ---------------------------------------------------------------------------
describe("runShipCostResolution — manual override", () => {
  it("manual override wins over allocation and stamps source 'manual'", async () => {
    const tables: Record<string, any[]> = {
      v_order_ship_features: [
        { id: "a", shop_id: "shop1", customer_country: "US", grams_sum: 100, item_count: 1, fulfillment_count: 1, ship_cost_manual_cents: 999 },
        { id: "b", shop_id: "shop1", customer_country: "US", grams_sum: 100, item_count: 1, fulfillment_count: 1, ship_cost_manual_cents: null },
      ],
      shipping_cost_period: [{ shop_id: "shop1", total_cents: 8000, source: "upload" }],
      shipping_invoice_line: [],
      order_fact: [],
      order_line_fact: [],
      sku_pnl: [],
    };

    const sb = makeSupabaseFake(tables);
    await runShipCostResolution(sb as any, "shop1", { shopCountry: "US" });

    const writes = orderWrites(sb);
    const a = writes.find((r: any) => r.id === "a")!;
    expect(a.ship_cost_cents).toBe(999);
    expect(a.ship_cost_source).toBe("manual");
    expect(a.ship_cost_confidence).toBe("high");
    // b has no override → still reconciled allocation
    expect(writes.find((r: any) => r.id === "b")!.ship_cost_source).toBe("reconciled");
  });
});

// ---------------------------------------------------------------------------
// Test 2c: weight model — no manual/invoice/period cost → estimate from
// weight × zone, source 'modeled'; an order with no weight falls to fallback.
// ---------------------------------------------------------------------------
describe("runShipCostResolution — weight model", () => {
  it("estimates ship cost from weight × zone and stamps source 'modeled'", async () => {
    const tables: Record<string, any[]> = {
      v_order_ship_features: [
        { id: "o1", shop_id: "shop1", customer_country: "US", grams_sum: 1000, item_count: 1, fulfillment_count: 1, ship_cost_manual_cents: null },
        { id: "o2", shop_id: "shop1", customer_country: "US", grams_sum: null, item_count: 1, fulfillment_count: 1, ship_cost_manual_cents: null },
      ],
      shipping_cost_period: [], // no period total → no allocation
      shipping_invoice_line: [], // no invoice
      order_fact: [],
      order_line_fact: [],
      sku_pnl: [],
    };

    const sb = makeSupabaseFake(tables);
    await runShipCostResolution(sb as any, "shop1", { shopCountry: "US" });

    const writes = orderWrites(sb);
    const o1 = writes.find((r: any) => r.id === "o1")!;
    // 1 kg, domestic (×1) → default rate, low confidence.
    expect(o1.ship_cost_source).toBe("modeled");
    expect(o1.ship_cost_confidence).toBe("low");
    expect(o1.ship_cost_cents).toBe(DEFAULT_SHIP_RATE_PER_KG_CENTS);
    // o2 has no weight → model returns null → falls through to fallback (no real cost).
    const o2 = writes.find((r: any) => r.id === "o2")!;
    expect(o2.ship_cost_source).toBe("fallback");
  });
});

// ---------------------------------------------------------------------------
// Test 3: rollShipCostIntoSkuPnl reduces contribution_margin_cents
// ---------------------------------------------------------------------------
describe("rollShipCostIntoSkuPnl", () => {
  it("updates sku_pnl row: contribution_margin_cents drops by attributed ship_cost", async () => {
    const tables: Record<string, any[]> = {
      order_fact: [
        { id: "o1", shop_id: "shop1", created_at_source: "2026-01-15T10:00:00Z", ship_cost_cents: 400 },
      ],
      order_line_fact: [
        { id: "l1", order_id: "o1", shop_id: "shop1", sku_id: "sku-A", grams: 200, quantity: 1 },
      ],
      sku_pnl: [
        {
          id: "pnl1",
          shop_id: "shop1",
          sku_id: "sku-A",
          day: "2026-01-15",
          revenue_cents: 10000,
          cogs_cents: 3000,
          ad_spend_attrib_cents: 1500,
          return_cents: 200,
        },
      ],
    };

    const sb = makeSupabaseFake(tables);
    await rollShipCostIntoSkuPnl(sb as any, "shop1");

    const writes = pnlWrites(sb);
    expect(writes).toHaveLength(1);
    expect(sb._updates.filter((u: UpdateRecord) => u.table === "sku_pnl")).toHaveLength(0);
    for (const call of rpcCalls(sb, "ship_cost_apply_sku_pnl_updates")) {
      expect(call.args.p_shop_id).toBe("shop1");
    }

    // All 400 cents attributed to the one line/sku
    expect(writes[0].id).toBe("pnl1");
    expect(writes[0].ship_cost_cents).toBe(400);
    // contribution = 10000 - 3000 - 1500 - 200 - 400 = 4900
    expect(writes[0].contribution_margin_cents).toBe(4900);
  });
});

// ---------------------------------------------------------------------------
// Test 4: >1000 rows — runShipCostResolution must resolve EVERY order, not just
// the first PostgREST-truncated 1000, and must land the writes in batched RPC
// calls (≤1000 rows each), never one round-trip per order. Regression for prod:
// ~11k serial per-order updates per tick exhausted the 300s cron ceiling (504).
// ---------------------------------------------------------------------------
describe("runShipCostResolution — processes all rows past the 1000-row truncation, batched", () => {
  it("resolves all 2500 orders in one tick via 3 batched RPC calls", async () => {
    const N = 2500;
    const orders = Array.from({ length: N }, (_, i) => ({
      id: `o${i}`,
      shop_id: "shop1",
      customer_country: "US",
      grams_sum: 100,
      item_count: 1,
      fulfillment_count: 1,
      ship_cost_manual_cents: null,
    }));

    const tables: Record<string, any[]> = {
      v_order_ship_features: orders,
      shipping_cost_period: [{ shop_id: "shop1", total_cents: 1_000_000 }],
      shipping_invoice_line: [],
      order_fact: [],
      order_line_fact: [],
      sku_pnl: [],
    };

    const sb = makeSupabaseFake(tables);
    await runShipCostResolution(sb as any, "shop1", { shopCountry: "US" });

    const calls = rpcCalls(sb, "ship_cost_apply_order_updates");
    // 2500 changed rows in ≤1000-row batches → exactly 3 round-trips.
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect((call.args.p_rows as any[]).length).toBeLessThanOrEqual(1000);
    }

    const writes = orderWrites(sb);
    // Every order must be reconciled — not just the first 1000.
    expect(writes).toHaveLength(N);
    const writtenIds = new Set(writes.map((r: any) => r.id));
    expect(writtenIds.size).toBe(N);
    expect(writtenIds.has("o0")).toBe(true);
    expect(writtenIds.has(`o${N - 1}`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 5: >1000 rows — rollShipCostIntoSkuPnl must read every order_fact,
// order_line_fact and sku_pnl row, not the first truncated 1000 of each, and
// must batch its writes the same way.
// ---------------------------------------------------------------------------
describe("rollShipCostIntoSkuPnl — processes all rows past the 1000-row truncation, batched", () => {
  it("updates all 1500 sku_pnl rows via 2 batched RPC calls", async () => {
    const N = 1500;
    const orderFacts = Array.from({ length: N }, (_, i) => ({
      id: `o${i}`,
      shop_id: "shop1",
      created_at_source: "2026-01-15T10:00:00Z",
      ship_cost_cents: 400,
    }));
    const orderLines = Array.from({ length: N }, (_, i) => ({
      id: `l${i}`,
      order_id: `o${i}`,
      shop_id: "shop1",
      sku_id: `sku-${i}`,
      grams: 200,
      quantity: 1,
    }));
    const pnlRows = Array.from({ length: N }, (_, i) => ({
      id: `pnl${i}`,
      shop_id: "shop1",
      sku_id: `sku-${i}`,
      day: "2026-01-15",
      revenue_cents: 10000,
      cogs_cents: 3000,
      ad_spend_attrib_cents: 1500,
      return_cents: 200,
    }));

    const tables: Record<string, any[]> = {
      order_fact: orderFacts,
      order_line_fact: orderLines,
      sku_pnl: pnlRows,
    };

    const sb = makeSupabaseFake(tables);
    await rollShipCostIntoSkuPnl(sb as any, "shop1");

    const calls = rpcCalls(sb, "ship_cost_apply_sku_pnl_updates");
    expect(calls).toHaveLength(2);

    const writes = pnlWrites(sb);
    // Every sku_pnl row gets its ship cost rolled in — only possible if the
    // order_fact, order_line_fact AND sku_pnl reads all paged past 1000 rows.
    expect(writes).toHaveLength(N);
    const writtenIds = new Set(writes.map((r: any) => r.id));
    expect(writtenIds.size).toBe(N);
    expect(writtenIds.has("pnl0")).toBe(true);
    expect(writtenIds.has(`pnl${N - 1}`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 6: steady state is a no-op — when every order's stored resolution and
// every sku_pnl row already match what this tick computes, the runner issues
// ZERO writes. This is the core of the cron-504 fix: with ~4k orders per shop
// re-resolved every 30 minutes, unchanged rows must cost nothing.
// ---------------------------------------------------------------------------
describe("runShipCostResolution — steady-state no-op", () => {
  it("skips orders whose stored ship_cost values equal the resolved values", async () => {
    const tables: Record<string, any[]> = {
      v_order_ship_features: [
        // Stored values match what resolution will produce → no write.
        {
          id: "a", shop_id: "shop1", customer_country: "US", grams_sum: 100, item_count: 1,
          fulfillment_count: 1, ship_cost_manual_cents: 999,
          ship_cost_cents: 999, ship_cost_source: "manual", ship_cost_confidence: "high",
        },
        {
          id: "b", shop_id: "shop1", customer_country: "US", grams_sum: 1000, item_count: 1,
          fulfillment_count: 1, ship_cost_manual_cents: null,
          ship_cost_cents: DEFAULT_SHIP_RATE_PER_KG_CENTS, ship_cost_source: "modeled", ship_cost_confidence: "low",
        },
      ],
      shipping_cost_period: [],
      shipping_invoice_line: [],
      order_fact: [],
      order_line_fact: [],
      sku_pnl: [],
    };

    const sb = makeSupabaseFake(tables);
    await runShipCostResolution(sb as any, "shop1", { shopCountry: "US" });

    expect(sb._rpcs).toHaveLength(0);
    expect(sb._updates).toHaveLength(0);
  });

  it("writes ONLY the orders whose resolution changed", async () => {
    const tables: Record<string, any[]> = {
      v_order_ship_features: [
        // Unchanged.
        {
          id: "a", shop_id: "shop1", customer_country: "US", grams_sum: 100, item_count: 1,
          fulfillment_count: 1, ship_cost_manual_cents: 999,
          ship_cost_cents: 999, ship_cost_source: "manual", ship_cost_confidence: "high",
        },
        // Stored cents are stale (off by one) → must be rewritten.
        {
          id: "b", shop_id: "shop1", customer_country: "US", grams_sum: 1000, item_count: 1,
          fulfillment_count: 1, ship_cost_manual_cents: null,
          ship_cost_cents: DEFAULT_SHIP_RATE_PER_KG_CENTS + 1, ship_cost_source: "modeled", ship_cost_confidence: "low",
        },
      ],
      shipping_cost_period: [],
      shipping_invoice_line: [],
      order_fact: [],
      order_line_fact: [],
      sku_pnl: [],
    };

    const sb = makeSupabaseFake(tables);
    await runShipCostResolution(sb as any, "shop1", { shopCountry: "US" });

    const writes = orderWrites(sb);
    expect(writes).toHaveLength(1);
    expect(writes[0].id).toBe("b");
    expect(writes[0].ship_cost_cents).toBe(DEFAULT_SHIP_RATE_PER_KG_CENTS);
  });
});

// ---------------------------------------------------------------------------
// Test 7: failures are loud and readable. A failed batch RPC or a failed paged
// read must throw a real Error with the PostgREST message/code in it — throwing
// the raw {message, code} object String()s to "[object Object]" in callers
// that only handle Error instances (cron.ingest-ship-costs' sync_error write),
// and a swallowed read error silently no-ops the whole phase.
// ---------------------------------------------------------------------------
describe("runShipCostResolution — failures are loud and readable", () => {
  it("throws a real Error carrying the PostgREST message when a batch RPC fails", async () => {
    const tables: Record<string, any[]> = {
      v_order_ship_features: [
        { id: "o1", shop_id: "shop1", customer_country: "US", grams_sum: 1000, item_count: 1, fulfillment_count: 1, ship_cost_manual_cents: null },
      ],
      shipping_cost_period: [],
      shipping_invoice_line: [],
      order_fact: [],
      order_line_fact: [],
      sku_pnl: [],
    };
    const sb = makeSupabaseFake(tables);
    sb.rpc = () =>
      Promise.resolve({
        data: null,
        error: { message: "function does not exist", code: "PGRST202" },
      });

    const run = runShipCostResolution(sb as any, "shop1", { shopCountry: "US" });
    await expect(run).rejects.toBeInstanceOf(Error);
    await expect(
      runShipCostResolution(sb as any, "shop1", { shopCountry: "US" }),
    ).rejects.toThrow(/function does not exist.*PGRST202/);
  });

  it("throws a real Error when a paged read fails, instead of no-opping on an empty page", async () => {
    // Minimal fake: every select resolves to a PostgREST error (e.g. the view is
    // missing the new columns because the migration has not been applied).
    const failingChain: any = {
      select: () => failingChain,
      eq: () => failingChain,
      in: () => failingChain,
      not: () => failingChain,
      order: () => failingChain,
      range: () => failingChain,
      then: (cb: (r: { data: null; error: unknown }) => unknown) =>
        Promise.resolve(cb({ data: null, error: { message: "column v_order_ship_features.ship_cost_cents does not exist", code: "42703" } })),
    };
    const sb: any = { from: () => failingChain, rpc: () => Promise.resolve({ data: null, error: null }) };

    await expect(
      runShipCostResolution(sb, "shop1", { shopCountry: "US" }),
    ).rejects.toThrow(/does not exist.*42703/);
  });
});

// ---------------------------------------------------------------------------
// Test 8: a sku_pnl row whose computed ship cost drops back to ZERO must be
// zeroed out, not skipped — the old unconditional `=== 0` continue left the
// stale cost and stale margin in place forever once an invoice/period went away.
// ---------------------------------------------------------------------------
describe("rollShipCostIntoSkuPnl — nonzero → 0 transition", () => {
  it("writes a zero ship cost over a stale stored nonzero cost and restores the margin", async () => {
    const tables: Record<string, any[]> = {
      order_fact: [
        // The order's resolved cost dropped to 0 (e.g. its invoice line was unmapped).
        { id: "o1", shop_id: "shop1", created_at_source: "2026-01-15T10:00:00Z", ship_cost_cents: 0 },
      ],
      order_line_fact: [
        { id: "l1", order_id: "o1", shop_id: "shop1", sku_id: "sku-A", grams: 200, quantity: 1 },
      ],
      sku_pnl: [
        {
          id: "pnl1",
          shop_id: "shop1",
          sku_id: "sku-A",
          day: "2026-01-15",
          revenue_cents: 10000,
          cogs_cents: 3000,
          ad_spend_attrib_cents: 1500,
          return_cents: 200,
          // Stale numbers from when the order carried a 400c cost.
          ship_cost_cents: 400,
          contribution_margin_cents: 4900,
        },
      ],
    };

    const sb = makeSupabaseFake(tables);
    await rollShipCostIntoSkuPnl(sb as any, "shop1");

    const writes = pnlWrites(sb);
    expect(writes).toHaveLength(1);
    expect(writes[0].id).toBe("pnl1");
    expect(writes[0].ship_cost_cents).toBe(0);
    // margin recomputed without ship cost: 10000 - 3000 - 1500 - 200 - 0 = 5300
    expect(writes[0].contribution_margin_cents).toBe(5300);
  });
});

describe("rollShipCostIntoSkuPnl — steady-state no-op", () => {
  it("skips sku_pnl rows whose stored ship cost and margin already match", async () => {
    const tables: Record<string, any[]> = {
      order_fact: [
        { id: "o1", shop_id: "shop1", created_at_source: "2026-01-15T10:00:00Z", ship_cost_cents: 400 },
      ],
      order_line_fact: [
        { id: "l1", order_id: "o1", shop_id: "shop1", sku_id: "sku-A", grams: 200, quantity: 1 },
      ],
      sku_pnl: [
        {
          id: "pnl1",
          shop_id: "shop1",
          sku_id: "sku-A",
          day: "2026-01-15",
          revenue_cents: 10000,
          cogs_cents: 3000,
          ad_spend_attrib_cents: 1500,
          return_cents: 200,
          // Already rolled in on a previous tick → this tick must not write.
          ship_cost_cents: 400,
          contribution_margin_cents: 4900,
        },
      ],
    };

    const sb = makeSupabaseFake(tables);
    await rollShipCostIntoSkuPnl(sb as any, "shop1");

    expect(sb._rpcs).toHaveLength(0);
    expect(sb._updates).toHaveLength(0);
  });
});
