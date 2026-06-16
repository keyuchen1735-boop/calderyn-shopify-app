/* eslint-disable @typescript-eslint/no-explicit-any -- stateful in-memory supabase fake */
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { landShipmentCharges } from "../land.server";
import { matchInvoiceLines, type MatchOrder } from "../../match";
import type { NormalizedShipmentCost } from "../adapter";

// ─────────────────────────────────────────────────────────────────────────────
// Stateful in-memory Supabase fake. Unlike the shared ship-cost helper (which is
// stateless and re-reads the seed each .from()), this one MUTATES backing arrays so
// insert→select→delete→re-insert is real — required to prove idempotency and the
// period-total recompute (rule 9: behavior, not implementation). Supports exactly the
// query shapes land.server.ts uses.
// ─────────────────────────────────────────────────────────────────────────────
type Row = Record<string, any>;

function makeDb(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = {};
  for (const [k, v] of Object.entries(seed)) tables[k] = v.map((r) => ({ ...r }));
  let idSeq = 1;

  function from(table: string) {
    tables[table] ??= [];
    // Each builder call starts fresh filter state.
    const eqs: Array<[string, unknown]> = [];
    const ins: Array<[string, unknown[]]> = [];
    let mode: "select" | "delete" | "update" | null = null;
    let updatePayload: Row | null = null;

    function applyFilters(rows: Row[]): Row[] {
      let out = rows;
      for (const [c, v] of eqs) out = out.filter((r) => r[c] === v);
      for (const [c, vs] of ins) out = out.filter((r) => vs.includes(r[c]));
      return out;
    }

    function runTerminal(): { data: any; error: null } {
      const rows = tables[table];
      if (mode === "delete") {
        const survivors = rows.filter((r) => !applyFilters([r]).length);
        tables[table] = survivors;
        return { data: null, error: null };
      }
      if (mode === "update") {
        for (const r of applyFilters(rows)) Object.assign(r, updatePayload);
        return { data: null, error: null };
      }
      // select
      return { data: applyFilters(rows), error: null };
    }

    const builder: any = {
      select() {
        if (mode == null) mode = "select";
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
      insert(payload: Row | Row[]) {
        // insert resolves immediately (below); it never routes through runTerminal,
        // so `mode` is left untouched.
        const list = Array.isArray(payload) ? payload : [payload];
        const inserted = list.map((p) => ({ id: `row-${idSeq++}`, ...p }));
        tables[table].push(...inserted);
        const single = Array.isArray(payload) ? inserted : inserted[0];
        // insert may be awaited directly OR chained with .select("id").single().
        return {
          select() {
            return {
              single: async () => ({ data: inserted[0], error: null }),
              maybeSingle: async () => ({ data: inserted[0], error: null }),
            };
          },
          then: (cb: (r: { data: any; error: null }) => unknown) =>
            Promise.resolve(cb({ data: single, error: null })),
        };
      },
      update(payload: Row) {
        mode = "update";
        updatePayload = payload;
        return builder;
      },
      delete() {
        mode = "delete";
        return builder;
      },
      maybeSingle: async () => {
        const { data } = runTerminal();
        return { data: Array.isArray(data) ? (data[0] ?? null) : data, error: null };
      },
      single: async () => {
        const { data } = runTerminal();
        return { data: Array.isArray(data) ? (data[0] ?? null) : data, error: null };
      },
      then: (cb: (r: { data: any; error: null }) => unknown) => Promise.resolve(cb(runTerminal())),
    };
    return builder;
  }

  return {
    sb: { from } as unknown as SupabaseClient,
    table: (t: string) => tables[t] ?? [],
  };
}

const SHOP = "shop1";

function charge(p: Partial<NormalizedShipmentCost> & { externalId: string }): NormalizedShipmentCost {
  return {
    externalId: p.externalId,
    orderRef: p.orderRef ?? null,
    trackingNo: p.trackingNo ?? null,
    costCents: p.costCents ?? 100,
    currency: p.currency ?? "USD",
    shippedAt: p.shippedAt ?? "2026-06-01T00:00:00Z",
    carrier: p.carrier ?? "USPS",
  };
}

describe("landShipmentCharges — synthetic period", () => {
  it("creates exactly one source='connector' period for (shop, provider) and reuses it", async () => {
    const { sb, table } = makeDb({
      shipping_cost_period: [],
      shipping_invoice_line: [],
      order_fact: [],
      fulfillment_fact: [],
    });
    await landShipmentCharges(sb, SHOP, "easypost", [charge({ externalId: "shp_1", trackingNo: "t1" })]);
    await landShipmentCharges(sb, SHOP, "easypost", [charge({ externalId: "shp_2", trackingNo: "t2" })]);
    const periods = table("shipping_cost_period").filter((p) => p.source === "connector");
    expect(periods).toHaveLength(1);
    expect(periods[0]).toMatchObject({ shop_id: SHOP, carrier: "easypost", source: "connector" });
  });
});

describe("landShipmentCharges — pre-aggregation (C4.3)", () => {
  it("sums multiple matched charges for ONE order into a single line", async () => {
    const { sb, table } = makeDb({
      shipping_cost_period: [],
      shipping_invoice_line: [],
      order_fact: [{ id: "o1", shop_id: SHOP, order_number: "#1001" }],
      fulfillment_fact: [],
    });
    await landShipmentCharges(sb, SHOP, "easypost", [
      charge({ externalId: "shp_a", orderRef: "#1001", costCents: 739 }),
      charge({ externalId: "shp_b", orderRef: "#1001", costCents: 512 }),
    ]);
    const lines = table("shipping_invoice_line");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ matched_order_id: "o1", cost_cents: 1251 });
  });

  it("matches via tracking number when orderRef is absent", async () => {
    const { sb, table } = makeDb({
      shipping_cost_period: [],
      shipping_invoice_line: [],
      order_fact: [{ id: "o9", shop_id: SHOP, order_number: "#9" }],
      fulfillment_fact: [{ order_id: "o9", shop_id: SHOP, tracking_no: "1Z-TRACK" }],
    });
    const res = await landShipmentCharges(sb, SHOP, "easypost", [
      charge({ externalId: "shp_t", orderRef: null, trackingNo: "1Z-TRACK", costCents: 400 }),
    ]);
    expect(res.matchedOrderCount).toBe(1);
    expect(table("shipping_invoice_line")[0]).toMatchObject({ matched_order_id: "o9", cost_cents: 400 });
  });
});

describe("landShipmentCharges — idempotent re-pull (success criterion #3)", () => {
  it("landing the same charge set twice does NOT duplicate rows", async () => {
    const seed = {
      shipping_cost_period: [] as Row[],
      shipping_invoice_line: [] as Row[],
      order_fact: [{ id: "o1", shop_id: SHOP, order_number: "#1001" }],
      fulfillment_fact: [] as Row[],
    };
    const { sb, table } = makeDb(seed);
    const charges = [
      charge({ externalId: "shp_a", orderRef: "#1001", costCents: 739 }),
      charge({ externalId: "shp_b", orderRef: "#1001", costCents: 512 }),
      charge({ externalId: "shp_u", orderRef: "#404", costCents: 200 }), // unmatched
    ];
    await landShipmentCharges(sb, SHOP, "easypost", charges);
    await landShipmentCharges(sb, SHOP, "easypost", charges);

    const lines = table("shipping_invoice_line");
    // 1 aggregated matched line for o1 + 1 unmatched line — unchanged after re-pull.
    expect(lines).toHaveLength(2);
    expect(lines.filter((l) => l.matched_order_id === "o1")).toHaveLength(1);
    expect(lines.filter((l) => l.matched_order_id === null)).toHaveLength(1);
  });

  it("PRESERVES an out-of-window line (the delete is scoped to the window key-set, not the whole period)", async () => {
    const { sb, table } = makeDb({
      shipping_cost_period: [],
      shipping_invoice_line: [],
      order_fact: [{ id: "o1", shop_id: SHOP, order_number: "#1001" }],
      fulfillment_fact: [],
    });
    // Pull 1: an older shipment lands.
    await landShipmentCharges(sb, SHOP, "easypost", [charge({ externalId: "shp_OLD", orderRef: "#1001", costCents: 100 })]);
    // Pull 2: a NEW window that does NOT include shp_OLD's id. shp_OLD must survive
    // (its actual_invoice cost would otherwise be silently lost). This is the case that
    // fails if the delete were `.eq(period_id)` alone without the external_charge_id `.in()`.
    await landShipmentCharges(sb, SHOP, "easypost", [charge({ externalId: "shp_NEW", orderRef: "#1001", costCents: 250 })]);

    const lines = table("shipping_invoice_line");
    expect(lines.map((l) => l.external_charge_id).sort()).toEqual(["shp_NEW", "shp_OLD"]);
    // Period total reflects BOTH lines (history preserved + new landed).
    const period = table("shipping_cost_period").find((p) => p.source === "connector");
    expect(period?.total_cents).toBe(350);
  });

  it("de-duplicates a repeated externalId within ONE pull (never double-counts the cost)", async () => {
    const { sb, table } = makeDb({
      shipping_cost_period: [],
      shipping_invoice_line: [],
      order_fact: [{ id: "o1", shop_id: SHOP, order_number: "#1001" }],
      fulfillment_fact: [],
    });
    const dup = charge({ externalId: "shp_dup", orderRef: "#1001", costCents: 500 });
    const res = await landShipmentCharges(sb, SHOP, "easypost", [dup, dup]);

    expect(res.duplicateExternalIdCount).toBe(1);
    const lines = table("shipping_invoice_line");
    expect(lines).toHaveLength(1);
    expect(lines[0].cost_cents).toBe(500); // 500, NOT 1000
  });
});

describe("landShipmentCharges — unmatched surfaced, never dropped (rule 12)", () => {
  it("an unmatched charge lands with matched_order_id NULL and is counted", async () => {
    const { sb, table } = makeDb({
      shipping_cost_period: [],
      shipping_invoice_line: [],
      order_fact: [],
      fulfillment_fact: [],
    });
    const res = await landShipmentCharges(sb, SHOP, "easypost", [
      charge({ externalId: "shp_x", orderRef: "#NOPE", trackingNo: "GHOST", costCents: 333 }),
    ]);
    expect(res.unmatchedCount).toBe(1);
    expect(res.matchedOrderCount).toBe(0);
    const lines = table("shipping_invoice_line");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ matched_order_id: null, cost_cents: 333, external_charge_id: "shp_x" });
  });

  it("a charge with neither tracking nor order ref is surfaced as skipped, not landed as an orphan", async () => {
    const { sb, table } = makeDb({
      shipping_cost_period: [],
      shipping_invoice_line: [],
      order_fact: [],
      fulfillment_fact: [],
    });
    const res = await landShipmentCharges(sb, SHOP, "easypost", [
      charge({ externalId: "shp_keyless", orderRef: null, trackingNo: null, costCents: 999 }),
    ]);
    expect(res.skippedNoKeyCount).toBe(1);
    expect(table("shipping_invoice_line")).toHaveLength(0);
  });
});

// Part A (same-id adjustment) — the case RECONCILIATION.md §1 claims works with zero new
// code. A carrier re-weighs a shipment; the provider re-emits the SAME externalId with the
// settled (higher) cost on the next trailing-window re-pull. The delete-by-keyset replace
// must OVERWRITE the existing line (settled cost), NOT add a second summed line — mandatory
// because the resolver is last-write-wins / not summed. This pins the doc's "DONE" claim.
describe("landShipmentCharges — same-id carrier adjustment overwrites (Part A §1)", () => {
  it("re-pulling the same externalId with a settled cost overwrites the line (no double-count)", async () => {
    const { sb, table } = makeDb({
      shipping_cost_period: [],
      shipping_invoice_line: [],
      order_fact: [{ id: "o1", shop_id: SHOP, order_number: "#1001" }],
      fulfillment_fact: [],
    });
    // Pull 1: original label cost 1000 for order o1.
    await landShipmentCharges(sb, SHOP, "easypost", [
      charge({ externalId: "shp_adj", orderRef: "#1001", costCents: 1000 }),
    ]);
    let lines = table("shipping_invoice_line");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ matched_order_id: "o1", cost_cents: 1000 });

    // Pull 2: the SAME shipment id re-emitted at the settled cost 1250 (carrier APV re-weigh).
    await landShipmentCharges(sb, SHOP, "easypost", [
      charge({ externalId: "shp_adj", orderRef: "#1001", costCents: 1250 }),
    ]);
    lines = table("shipping_invoice_line");
    // Exactly ONE line for o1, holding the SETTLED cost — not 1000, not 2250.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ matched_order_id: "o1", cost_cents: 1250, external_charge_id: "shp_adj" });
    // Period total reflects the settled amount only.
    const period = table("shipping_cost_period").find((p) => p.source === "connector");
    expect(period?.total_cents).toBe(1250);
  });
});

describe("landShipmentCharges — period total recompute (C4.5)", () => {
  it("sets total_cents = Σ of all the period's lines", async () => {
    const { sb, table } = makeDb({
      shipping_cost_period: [],
      shipping_invoice_line: [],
      order_fact: [{ id: "o1", shop_id: SHOP, order_number: "#1001" }],
      fulfillment_fact: [],
    });
    const res = await landShipmentCharges(sb, SHOP, "easypost", [
      charge({ externalId: "shp_a", orderRef: "#1001", costCents: 739 }),
      charge({ externalId: "shp_b", orderRef: "#1001", costCents: 512 }),
      charge({ externalId: "shp_u", orderRef: "#404", costCents: 200 }),
    ]);
    expect(res.totalCents).toBe(1451);
    const period = table("shipping_cost_period").find((p) => p.source === "connector");
    expect(period?.total_cents).toBe(1451);
  });
});

// matchCharge inside land.server.ts is a deliberate mirror of match.ts. This pins the
// two together so they can never silently drift (the reason match.ts is left unchanged).
describe("landShipmentCharges — matching parity with matchInvoiceLines (C5)", () => {
  it("lands exactly the orders matchInvoiceLines would match for the same inputs", async () => {
    const orders: MatchOrder[] = [
      { id: "o1", orderNumber: "#1001", trackingNos: [] },
      { id: "o2", orderNumber: "#2002", trackingNos: ["TRK2"] },
      { id: "o3", orderNumber: "#3003", trackingNos: ["TRK3"] },
    ];
    const charges = [
      charge({ externalId: "a", orderRef: "1001" }), // matches o1 (ref, '#'-insensitive)
      charge({ externalId: "b", orderRef: null, trackingNo: "trk2" }), // matches o2 (tracking, case-insensitive)
      charge({ externalId: "c", orderRef: "#404", trackingNo: "ZZZ" }), // unmatched
      // wrong ref BUT right tracking → must fall through ref-miss to a tracking match (o3).
      // This is the precedence case that distinguishes ref-first-then-tracking from
      // ref-only; without the `if (!id && trackingNo)` fallback it would land unmatched.
      charge({ externalId: "d", orderRef: "#NOPE", trackingNo: "trk3" }),
    ];
    const expected = matchInvoiceLines(
      charges.map((c) => ({ orderRef: c.orderRef, trackingNo: c.trackingNo, costCents: c.costCents })),
      orders,
    );
    const expectedMatchedOrderIds = new Set(expected.matched.map((m) => m.matchedOrderId));

    const { sb, table } = makeDb({
      shipping_cost_period: [],
      shipping_invoice_line: [],
      order_fact: [
        { id: "o1", shop_id: SHOP, order_number: "#1001" },
        { id: "o2", shop_id: SHOP, order_number: "#2002" },
        { id: "o3", shop_id: SHOP, order_number: "#3003" },
      ],
      fulfillment_fact: [
        { order_id: "o2", shop_id: SHOP, tracking_no: "TRK2" },
        { order_id: "o3", shop_id: SHOP, tracking_no: "TRK3" },
      ],
    });
    const res = await landShipmentCharges(sb, SHOP, "easypost", charges);

    expect(res.matchedOrderCount).toBe(expected.matched.length);
    expect(res.unmatchedCount).toBe(expected.unmatched.length);
    const landedMatchedIds = new Set(
      table("shipping_invoice_line").filter((l) => l.matched_order_id).map((l) => l.matched_order_id),
    );
    expect(landedMatchedIds).toEqual(expectedMatchedOrderIds);
  });
});
