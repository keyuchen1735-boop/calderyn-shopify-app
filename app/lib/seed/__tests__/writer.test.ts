// app/lib/seed/__tests__/writer.test.ts
//
// The writer must atomically replace a shop's seed-origin rows: wipe children
// before parents, insert parents before children, batch under the PostgREST
// limit, and fail loudly on the first error (rule 12 — no silent partial seed).
import { describe, it, expect } from "vitest";
import { generateSeedDataset } from "../dataset";
import { writeSeedDataset, WIPE_ORDER, INSERT_ORDER } from "../writer";

const SHOP_ID = "24c18b19-3a4f-4651-9446-969726c30223";
const ds = generateSeedDataset({ shopId: SHOP_ID, today: "2026-06-09" });

interface Call {
  kind: "delete" | "insert";
  table: string;
  rows?: number;
}

function fakeClient(failOn?: string) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      return {
        delete() {
          return {
            eq(_col: string, _val: string) {
              calls.push({ kind: "delete", table });
              if (failOn === table) return Promise.resolve({ error: { message: `boom ${table}` } });
              return Promise.resolve({ error: null });
            },
          };
        },
        insert(rows: Record<string, unknown>[]) {
          calls.push({ kind: "insert", table, rows: rows.length });
          if (failOn === table) return Promise.resolve({ error: { message: `boom ${table}` } });
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return { client, calls };
}

describe("writeSeedDataset", () => {
  it("wipes every table it writes (plus alert tables), children before parents", async () => {
    const { client, calls } = fakeClient();
    await writeSeedDataset(ds, SHOP_ID, client);
    const deletes = calls.filter((c) => c.kind === "delete").map((c) => c.table);
    for (const table of INSERT_ORDER) expect(deletes, `missing wipe of ${table}`).toContain(table);
    for (const table of ["alerts", "alert_context", "action_audit", "action_idempotency", "ad_click_ref"]) {
      expect(deletes, `missing wipe of ${table}`).toContain(table);
    }
    // children wiped before their parents
    const pos = (t: string) => deletes.indexOf(t);
    expect(pos("order_line_fact")).toBeLessThan(pos("order_fact"));
    expect(pos("attribution_fact")).toBeLessThan(pos("ad_campaign_dim"));
    expect(pos("attribution_fact")).toBeLessThan(pos("order_fact"));
    expect(pos("ad_spend_fact")).toBeLessThan(pos("ad_campaign_dim"));
    expect(pos("alert_context")).toBeLessThan(pos("alerts"));
    expect(pos("inventory_level_fact")).toBeLessThan(pos("sku_dim"));
    expect(pos("order_fact")).toBeLessThan(pos("sku_dim"));
  });

  it("inserts parents before children and finishes the wipe first", async () => {
    const { client, calls } = fakeClient();
    await writeSeedDataset(ds, SHOP_ID, client);
    const lastDelete = calls.map((c) => c.kind).lastIndexOf("delete");
    const firstInsert = calls.map((c) => c.kind).indexOf("insert");
    expect(lastDelete).toBeLessThan(firstInsert);
    const inserts = calls.filter((c) => c.kind === "insert").map((c) => c.table);
    const pos = (t: string) => inserts.indexOf(t);
    expect(pos("location_dim")).toBeLessThan(pos("sku_dim"));
    expect(pos("sku_dim")).toBeLessThan(pos("order_line_fact"));
    expect(pos("order_fact")).toBeLessThan(pos("order_line_fact"));
    expect(pos("ad_campaign_dim")).toBeLessThan(pos("ad_spend_fact"));
    expect(pos("ad_campaign_dim")).toBeLessThan(pos("attribution_fact"));
    expect(pos("order_fact")).toBeLessThan(pos("attribution_fact"));
  });

  it("keeps every insert batch within the PostgREST page size", async () => {
    const { client, calls } = fakeClient();
    await writeSeedDataset(ds, SHOP_ID, client);
    for (const c of calls) {
      if (c.kind === "insert") expect(c.rows).toBeLessThanOrEqual(1000);
    }
    // and the big tables actually made it through in full
    const total = (table: string) =>
      calls.filter((c) => c.kind === "insert" && c.table === table).reduce((s, c) => s + (c.rows ?? 0), 0);
    expect(total("order_fact")).toBe(ds.orders.length);
    expect(total("inventory_level_fact")).toBe(ds.inventoryLevels.length);
  });

  it("throws on the first failed statement instead of seeding partially", async () => {
    const { client } = fakeClient("ad_spend_fact");
    await expect(writeSeedDataset(ds, SHOP_ID, client)).rejects.toThrow(/ad_spend_fact/);
  });

  it("refuses a dataset generated for a different shop", async () => {
    const { client } = fakeClient();
    await expect(writeSeedDataset(ds, "00000000-0000-4000-8000-000000000000", client)).rejects.toThrow(/shop/i);
  });
});

describe("orders", () => {
  it("exports a wipe order that covers the insert order", () => {
    for (const table of INSERT_ORDER) expect(WIPE_ORDER).toContain(table);
  });
});
