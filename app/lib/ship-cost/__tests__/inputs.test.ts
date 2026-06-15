import { describe, it, expect, vi } from "vitest";
import { saveTypedPeriodTotal, ingestInvoiceCsv, setManualOverride } from "../inputs.server";
import { makeFakeSupabase } from "./helpers";

vi.mock("../runner.server", () => ({ runShipCostResolution: vi.fn().mockResolvedValue(undefined) }));
import { runShipCostResolution } from "../runner.server";

describe("saveTypedPeriodTotal", () => {
  it("inserts a typed period row and re-resolves", async () => {
    const sb = makeFakeSupabase({ shipping_cost_period: [], order_fact: [], shipping_invoice_line: [] });
    await saveTypedPeriodTotal(sb, "s", { totalCents: 50000, carrier: "UPS", periodStart: "2026-05-01", periodEnd: "2026-05-31", shopCountry: "US" });
    const row = sb.inserts("shipping_cost_period")[0];
    expect(row).toMatchObject({ shop_id: "s", total_cents: 50000, carrier: "UPS", source: "typed", period_start: "2026-05-01", period_end: "2026-05-31" });
    expect(runShipCostResolution).toHaveBeenCalledWith(sb, "s", { shopCountry: "US" });
  });
});

describe("ingestInvoiceCsv", () => {
  it("creates an upload period, writes lines, returns unmatched, and re-resolves", async () => {
    const sb = makeFakeSupabase({
      shipping_cost_period: [],
      shipping_invoice_line: [],
      order_fact: [{ id: "o1", shop_id: "s", order_number: "#1001" }],
    });
    const csv = "order,tracking,cost\n#1001,1Z1,4.50\n#404,NOPE,7.00\n";
    const result = await ingestInvoiceCsv(sb, "s", { csvText: csv, carrier: "UPS", periodStart: "2026-05-01", periodEnd: "2026-05-31", shopCountry: "US" });
    expect(sb.inserts("shipping_cost_period")[0]).toMatchObject({ source: "upload", total_cents: 1150 });
    const lines = sb.inserts("shipping_invoice_line");
    expect(lines).toHaveLength(2);
    expect(lines.find((l: Record<string, unknown>) => l.order_ref === "#1001")!.matched_order_id).toBe("o1");
    expect(result.matchedCount).toBe(1);
    expect(result.unmatched).toEqual([{ orderRef: "#404", trackingNo: "NOPE", costCents: 700, matchedOrderId: null }]);
    expect(result.parseErrors).toEqual([]);
    expect(runShipCostResolution).toHaveBeenCalledWith(sb, "s", { shopCountry: "US" });
  });
});

describe("setManualOverride", () => {
  it("writes ship_cost_manual_cents and re-resolves", async () => {
    const sb = makeFakeSupabase({ order_fact: [{ id: "o1", shop_id: "s" }], shipping_cost_period: [], shipping_invoice_line: [] });
    await setManualOverride(sb, "s", { orderId: "o1", cents: 333, shopCountry: "US" });
    expect(sb.updates("order_fact")[0]).toMatchObject({ id: "o1", ship_cost_manual_cents: 333 });
    expect(runShipCostResolution).toHaveBeenCalledWith(sb, "s", { shopCountry: "US" });
  });
  it("clears the override when cents is null", async () => {
    const sb = makeFakeSupabase({ order_fact: [{ id: "o1", shop_id: "s" }], shipping_cost_period: [], shipping_invoice_line: [] });
    await setManualOverride(sb, "s", { orderId: "o1", cents: null, shopCountry: "US" });
    expect(sb.updates("order_fact")[0].ship_cost_manual_cents).toBeNull();
  });
});
