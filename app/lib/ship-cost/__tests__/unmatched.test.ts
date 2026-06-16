/* eslint-disable @typescript-eslint/no-explicit-any -- stateful in-memory supabase fake */
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getUnmatchedCharges,
  mapChargeToOrder,
  classifyUnmatched,
} from "../unmatched.server";

// Stateful in-memory Supabase fake supporting exactly the query shapes unmatched.server.ts
// uses: .select().eq().is(col, null) for reads, .select().eq().in() for the period lookup,
// and .update().eq().eq().is() for the attach. MUTATES backing arrays so the attach is real
// (matched_order_id flips, so a re-read drops the row from the unmatched set).
type Row = Record<string, any>;

function makeDb(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = {};
  for (const [k, v] of Object.entries(seed)) tables[k] = v.map((r) => ({ ...r }));

  function from(table: string) {
    tables[table] ??= [];
    const eqs: Array<[string, unknown]> = [];
    const ins: Array<[string, unknown[]]> = [];
    const iss: Array<[string, unknown]> = [];
    let mode: "select" | "update" = "select";
    let updatePayload: Row | null = null;

    function applyFilters(rows: Row[]): Row[] {
      let out = rows;
      for (const [c, v] of eqs) out = out.filter((r) => r[c] === v);
      for (const [c, vs] of ins) out = out.filter((r) => vs.includes(r[c]));
      for (const [c, v] of iss) out = out.filter((r) => (r[c] ?? null) === v);
      return out;
    }
    function runTerminal(): { data: any; error: null } {
      const rows = tables[table];
      if (mode === "update") {
        // Apply the payload to matched rows and RETURN those rows (so .select() after an
        // update can detect a no-op / affected-row count, mirroring PostgREST).
        const affected = applyFilters(rows);
        for (const r of affected) Object.assign(r, updatePayload);
        return { data: affected.map((r) => ({ ...r })), error: null };
      }
      return { data: applyFilters(rows), error: null };
    }

    const builder: any = {
      select() {
        return builder;
      },
      eq(col: string, val: unknown) {
        eqs.push([col, val]);
        return builder;
      },
      in(col: string, vals: unknown[]) {
        ins.push([col, vals]);
        return builder;
      },
      is(col: string, val: unknown) {
        iss.push([col, val]);
        return builder;
      },
      update(payload: Row) {
        mode = "update";
        updatePayload = payload;
        return builder;
      },
      then: (cb: (r: { data: any; error: null }) => unknown) => Promise.resolve(cb(runTerminal())),
    };
    return builder;
  }

  return { sb: { from } as unknown as SupabaseClient, table: (t: string) => tables[t] ?? [] };
}

const SHOP = "shop1";

describe("classifyUnmatched — reason derivation (rule 12 visibility)", () => {
  it("no ref AND no tracking → no_ref", () => {
    expect(classifyUnmatched({ order_ref: null, tracking_no: null })).toBe("no_ref");
    expect(classifyUnmatched({ order_ref: "  ", tracking_no: "" })).toBe("no_ref");
  });
  it("had a ref or tracking but didn't match → no_tracking_match", () => {
    expect(classifyUnmatched({ order_ref: "#404", tracking_no: null })).toBe("no_tracking_match");
    expect(classifyUnmatched({ order_ref: null, tracking_no: "GHOST" })).toBe("no_tracking_match");
  });
});

describe("getUnmatchedCharges — the Part C reader contract (C.1)", () => {
  it("returns count + items for matched_order_id IS NULL rows, with provider from the connector period", async () => {
    const { sb } = makeDb({
      shipping_invoice_line: [
        { id: "l1", shop_id: SHOP, matched_order_id: null, order_ref: "#404", tracking_no: "GHOST", cost_cents: 333, external_charge_id: "shp_x", period_id: "p_con" },
        { id: "l2", shop_id: SHOP, matched_order_id: "o1", order_ref: "#1", tracking_no: null, cost_cents: 100, external_charge_id: "shp_y", period_id: "p_con" }, // matched → excluded
      ],
      shipping_cost_period: [
        { id: "p_con", shop_id: SHOP, carrier: "easypost", source: "connector" },
      ],
      order_fact: [],
    });
    const res = await getUnmatchedCharges(sb, SHOP);
    expect(res.count).toBe(1);
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({
      id: "l1",
      provider: "easypost",
      orderRef: "#404",
      trackingNo: "GHOST",
      costCents: 333,
      externalChargeId: "shp_x",
      reason: "no_tracking_match",
    });
  });

  it("EXCLUDES an unmatched CSV-upload line (only connector charges are carrier charges)", async () => {
    // An 'upload'-source line also lands matched_order_id=NULL, but it is NOT a carrier
    // charge and must not appear on the unmatched-carrier-charges surface.
    const { sb } = makeDb({
      shipping_invoice_line: [
        { id: "l_con", shop_id: SHOP, matched_order_id: null, order_ref: "#404", tracking_no: null, cost_cents: 333, external_charge_id: "shp_x", period_id: "p_con" },
        { id: "l_csv", shop_id: SHOP, matched_order_id: null, order_ref: "#999", tracking_no: null, cost_cents: 500, external_charge_id: null, period_id: "p_up" },
      ],
      shipping_cost_period: [
        { id: "p_con", shop_id: SHOP, carrier: "easypost", source: "connector" },
        { id: "p_up", shop_id: SHOP, carrier: null, source: "upload" }, // CSV invoice period
      ],
      order_fact: [],
    });
    const res = await getUnmatchedCharges(sb, SHOP);
    expect(res.count).toBe(1);
    expect(res.items.map((i) => i.id)).toEqual(["l_con"]);
  });

  it("returns empty when the shop has no connector period at all (no false carrier banner)", async () => {
    const { sb } = makeDb({
      shipping_invoice_line: [
        { id: "l_csv", shop_id: SHOP, matched_order_id: null, order_ref: "#999", tracking_no: null, cost_cents: 500, external_charge_id: null, period_id: "p_up" },
      ],
      shipping_cost_period: [{ id: "p_up", shop_id: SHOP, carrier: null, source: "upload" }],
      order_fact: [],
    });
    const res = await getUnmatchedCharges(sb, SHOP);
    expect(res).toEqual({ count: 0, items: [] });
  });

  it("does not leak another shop's unmatched rows", async () => {
    const { sb } = makeDb({
      shipping_invoice_line: [
        { id: "mine", shop_id: SHOP, matched_order_id: null, order_ref: null, tracking_no: null, cost_cents: 1, external_charge_id: "a", period_id: "p" },
        { id: "theirs", shop_id: "other", matched_order_id: null, order_ref: null, tracking_no: null, cost_cents: 1, external_charge_id: "b", period_id: "p2" },
      ],
      shipping_cost_period: [{ id: "p", shop_id: SHOP, carrier: "easypost", source: "connector" }],
      order_fact: [],
    });
    const res = await getUnmatchedCharges(sb, SHOP);
    expect(res.count).toBe(1);
    expect(res.items[0].id).toBe("mine");
  });
});

describe("mapChargeToOrder — attach + visible failure (rule 12)", () => {
  it("attaches the line to the resolved order by order number and clears it from unmatched", async () => {
    const { sb, table } = makeDb({
      shipping_invoice_line: [
        { id: "l1", shop_id: SHOP, matched_order_id: null, order_ref: "#404", tracking_no: null, cost_cents: 500, external_charge_id: "shp_x", period_id: "p_con" },
      ],
      shipping_cost_period: [{ id: "p_con", shop_id: SHOP, carrier: "easypost", source: "connector" }],
      order_fact: [{ id: "o_real", shop_id: SHOP, order_number: "#1001" }],
    });
    const res = await mapChargeToOrder(sb, SHOP, "l1", "1001"); // '#'-insensitive
    expect(res).toMatchObject({ ok: true, orderId: "o_real" });
    expect(table("shipping_invoice_line")[0].matched_order_id).toBe("o_real");
    // Now the reader returns zero — the count decremented.
    const after = await getUnmatchedCharges(sb, SHOP);
    expect(after.count).toBe(0);
  });

  it("throws a visible error for an unknown order and changes nothing (no silent no-op)", async () => {
    const { sb, table } = makeDb({
      shipping_invoice_line: [
        { id: "l1", shop_id: SHOP, matched_order_id: null, order_ref: "#404", tracking_no: null, cost_cents: 500, external_charge_id: "shp_x", period_id: "p_con" },
      ],
      shipping_cost_period: [{ id: "p_con", shop_id: SHOP, carrier: "easypost", source: "connector" }],
      order_fact: [{ id: "o_real", shop_id: SHOP, order_number: "#1001" }],
    });
    await expect(mapChargeToOrder(sb, SHOP, "l1", "9999")).rejects.toThrow(/No order 9999 found/);
    // Untouched.
    expect(table("shipping_invoice_line")[0].matched_order_id).toBeNull();
  });

  it("fails visibly (no false success) when the line is already mapped — 0 rows affected", async () => {
    const { sb, table } = makeDb({
      shipping_invoice_line: [
        { id: "l1", shop_id: SHOP, matched_order_id: "o_other", order_ref: "#404", tracking_no: null, cost_cents: 500, external_charge_id: "shp_x", period_id: "p_con" },
      ],
      shipping_cost_period: [{ id: "p_con", shop_id: SHOP, carrier: "easypost", source: "connector" }],
      order_fact: [{ id: "o_real", shop_id: SHOP, order_number: "#1001" }],
    });
    // The order resolves, but the line is already matched (matched_order_id NOT NULL) so the
    // update matches 0 rows — must throw, not return ok:true (rule 12). Unchanged.
    await expect(mapChargeToOrder(sb, SHOP, "l1", "1001")).rejects.toThrow(/couldn't be mapped/);
    expect(table("shipping_invoice_line")[0].matched_order_id).toBe("o_other");
  });

  it("refuses to map a non-connector (CSV upload) line even if unmatched", async () => {
    const { sb, table } = makeDb({
      shipping_invoice_line: [
        { id: "l_csv", shop_id: SHOP, matched_order_id: null, order_ref: "#404", tracking_no: null, cost_cents: 500, external_charge_id: null, period_id: "p_up" },
      ],
      shipping_cost_period: [
        { id: "p_con", shop_id: SHOP, carrier: "easypost", source: "connector" },
        { id: "p_up", shop_id: SHOP, carrier: null, source: "upload" },
      ],
      order_fact: [{ id: "o_real", shop_id: SHOP, order_number: "#1001" }],
    });
    await expect(mapChargeToOrder(sb, SHOP, "l_csv", "1001")).rejects.toThrow(/couldn't be mapped/);
    expect(table("shipping_invoice_line")[0].matched_order_id).toBeNull();
  });
});
