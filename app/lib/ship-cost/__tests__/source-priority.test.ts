/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory supabase fake */
import { describe, it, expect } from "vitest";
import { runShipCostResolution } from "../runner.server";

// Phase 3, priority 1 — source-priority reconciliation. When an order has BOTH a
// CSV-upload invoice line and a connector invoice line, the runner must pick the cost
// DETERMINISTICALLY (connector > upload > typed), not by unordered row arrival. This
// fake honors .eq()/.in() as real filters and — crucially — preserves the ORDER of the
// seeded shipping_invoice_line rows so a naive last-write-wins implementation would be
// detectably order-sensitive (the bug this test guards). The runner.server fence query
// uses .in("source", ...); the period-source query and the invoice query are plain
// .eq("shop_id") selects whose row order this fake returns verbatim.
interface UpdateRecord {
  table: string;
  payload: Record<string, unknown>;
  filters: Record<string, unknown>;
}

function makeSupabaseFake(tables: Record<string, any[]>) {
  const updates: UpdateRecord[] = [];

  function makeChain(table: string, rows: any[]) {
    let selectedRows = rows;
    const chain: any = {
      select() {
        return chain;
      },
      eq(col: string, val: unknown) {
        selectedRows = selectedRows.filter((r) => r[col] === val);
        return chain;
      },
      in(col: string, vals: unknown[]) {
        selectedRows = selectedRows.filter((r) => vals.includes(r[col]));
        return chain;
      },
      not(col: string, _op: string, _val: unknown) {
        selectedRows = selectedRows.filter((r) => r[col] !== null && r[col] !== undefined);
        return chain;
      },
      update(payload: Record<string, unknown>) {
        const updateFilters: Record<string, unknown> = {};
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
        return Promise.resolve(cb({ data: selectedRows, error: null }));
      },
    };
    return chain;
  }

  return {
    sb: { from: (table: string) => makeChain(table, tables[table] ?? []) } as any,
    updates,
  };
}

function orderUpdate(updates: UpdateRecord[], id: string): UpdateRecord {
  const u = updates.find((x) => x.table === "order_fact" && x.filters.id === id);
  if (!u) throw new Error(`no order_fact update for ${id}`);
  return u;
}

describe("runShipCostResolution — source-priority reconciliation (Phase 3 #1)", () => {
  it("connector line OUTRANKS an upload line for the same order, regardless of row order", async () => {
    // Two periods for the same order's lines: an upload CSV (cost 1000) and a connector
    // charge (cost 1250 — the settled per-shipment cost). The connector cost must win.
    const tablesUploadFirst = {
      v_order_ship_features: [
        { id: "o1", shop_id: "s1", customer_country: "US", grams_sum: 100, item_count: 1, fulfillment_count: 1, ship_cost_manual_cents: null },
      ],
      shipping_cost_period: [
        { id: "p_up", shop_id: "s1", total_cents: 1000, source: "upload" },
        { id: "p_con", shop_id: "s1", total_cents: 1250, source: "connector" },
      ],
      // Upload line appears BEFORE the connector line in row order.
      shipping_invoice_line: [
        { shop_id: "s1", matched_order_id: "o1", cost_cents: 1000, period_id: "p_up" },
        { shop_id: "s1", matched_order_id: "o1", cost_cents: 1250, period_id: "p_con" },
      ],
      order_fact: [],
      order_line_fact: [],
      sku_pnl: [],
    };
    const a = makeSupabaseFake(tablesUploadFirst);
    await runShipCostResolution(a.sb, "s1", { shopCountry: "US" });
    const u1 = orderUpdate(a.updates, "o1");
    expect(u1.payload.ship_cost_source).toBe("actual_invoice");
    expect(u1.payload.ship_cost_cents).toBe(1250);

    // Same data, connector line FIRST → identical result (proves order-independence).
    const tablesConnectorFirst = {
      ...tablesUploadFirst,
      shipping_invoice_line: [
        { shop_id: "s1", matched_order_id: "o1", cost_cents: 1250, period_id: "p_con" },
        { shop_id: "s1", matched_order_id: "o1", cost_cents: 1000, period_id: "p_up" },
      ],
      order_fact: [],
      order_line_fact: [],
      sku_pnl: [],
    };
    const b = makeSupabaseFake(tablesConnectorFirst);
    await runShipCostResolution(b.sb, "s1", { shopCountry: "US" });
    const u2 = orderUpdate(b.updates, "o1");
    expect(u2.payload.ship_cost_cents).toBe(1250);
  });

  it("upload OUTRANKS typed for the same order (precedence connector > upload > typed)", async () => {
    const tables = {
      v_order_ship_features: [
        { id: "o1", shop_id: "s1", customer_country: "US", grams_sum: 100, item_count: 1, fulfillment_count: 1, ship_cost_manual_cents: null },
      ],
      shipping_cost_period: [
        { id: "p_typed", shop_id: "s1", total_cents: 800, source: "typed" },
        { id: "p_up", shop_id: "s1", total_cents: 900, source: "upload" },
      ],
      // Typed line LAST in row order — would win under naive last-write-wins, but upload
      // must outrank it.
      shipping_invoice_line: [
        { shop_id: "s1", matched_order_id: "o1", cost_cents: 900, period_id: "p_up" },
        { shop_id: "s1", matched_order_id: "o1", cost_cents: 800, period_id: "p_typed" },
      ],
      order_fact: [],
      order_line_fact: [],
      sku_pnl: [],
    };
    const { sb, updates } = makeSupabaseFake(tables);
    await runShipCostResolution(sb, "s1", { shopCountry: "US" });
    expect(orderUpdate(updates, "o1").payload.ship_cost_cents).toBe(900);
  });

  it("SAME source keeps last-write-wins (unchanged pre-Phase-3 behavior)", async () => {
    const tables = {
      v_order_ship_features: [
        { id: "o1", shop_id: "s1", customer_country: "US", grams_sum: 100, item_count: 1, fulfillment_count: 1, ship_cost_manual_cents: null },
      ],
      shipping_cost_period: [{ id: "p_con", shop_id: "s1", total_cents: 0, source: "connector" }],
      // Two connector lines for the same order (degenerate; the connector pre-aggregates,
      // but the runner must still be defined): last row wins, as before.
      shipping_invoice_line: [
        { shop_id: "s1", matched_order_id: "o1", cost_cents: 111, period_id: "p_con" },
        { shop_id: "s1", matched_order_id: "o1", cost_cents: 222, period_id: "p_con" },
      ],
      order_fact: [],
      order_line_fact: [],
      sku_pnl: [],
    };
    const { sb, updates } = makeSupabaseFake(tables);
    await runShipCostResolution(sb, "s1", { shopCountry: "US" });
    expect(orderUpdate(updates, "o1").payload.ship_cost_cents).toBe(222);
  });

  it("a manual override still wins over ANY invoice line (resolver tier order intact)", async () => {
    const tables = {
      v_order_ship_features: [
        { id: "o1", shop_id: "s1", customer_country: "US", grams_sum: 100, item_count: 1, fulfillment_count: 1, ship_cost_manual_cents: 555 },
      ],
      shipping_cost_period: [{ id: "p_con", shop_id: "s1", total_cents: 0, source: "connector" }],
      shipping_invoice_line: [
        { shop_id: "s1", matched_order_id: "o1", cost_cents: 1250, period_id: "p_con" },
      ],
      order_fact: [],
      order_line_fact: [],
      sku_pnl: [],
    };
    const { sb, updates } = makeSupabaseFake(tables);
    await runShipCostResolution(sb, "s1", { shopCountry: "US" });
    const u = orderUpdate(updates, "o1");
    expect(u.payload.ship_cost_source).toBe("manual");
    expect(u.payload.ship_cost_cents).toBe(555);
  });
});
