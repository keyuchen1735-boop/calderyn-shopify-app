import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as TransformServer from "../transform.server";
import { makeFakeSupabase } from "./fake-supabase";
import { OWNED_CHECKOUT_COMPLETED } from "../events";

const SHOP = "00000000-0000-0000-0000-000000000001";
const VARIANT = "22222222-2222-2222-2222-222222222222";

function rawRow(id: string, type: string = OWNED_CHECKOUT_COMPLETED, overrides: Record<string, unknown> = {}) {
  const payload = {
    event_id: id, type, shop_id: SHOP, occurred_at: "2026-06-30T12:00:00.000Z",
    order: {
      external_id: `owned-${id}`, order_number: "#1", total_cents: 2000, subtotal_cents: 2000,
      shipping_cents: 0, tax_cents: 0, discount_cents: 0, currency: "USD",
      financial_status: "paid", buyer_id: null, ...overrides,
    },
    lines: [{ external_line_id: `${id}-l1`, variant_id: VARIANT, quantity: 1, price_cents: 2000, total_cents: 2000 }],
  };
  return { id, shop_id: SHOP, type, payload, processed_at: null };
}

const applyOwnedOrder = vi.fn().mockResolvedValue(2);
vi.mock("../apply.server", () => ({ applyOwnedOrder: (...a: unknown[]) => applyOwnedOrder(...a) }));

let fake: ReturnType<typeof makeFakeSupabase>;
let transformPendingOwnedEvents: typeof TransformServer.transformPendingOwnedEvents;

async function load(seedRows: Row[]) {
  fake = makeFakeSupabase({ seed: { raw_owned_event: seedRows } });
  vi.doMock("../../../supabase.server", () => ({ getSupabase: () => fake.client }));
  ({ transformPendingOwnedEvents } = await import("../transform.server"));
}
type Row = Record<string, unknown>;

beforeEach(() => { vi.resetModules(); applyOwnedOrder.mockClear(); applyOwnedOrder.mockResolvedValue(2); });

describe("transformPendingOwnedEvents", () => {
  it("dispatches CHECKOUT_COMPLETED to applyOwnedOrder and stamps processed_at", async () => {
    await load([rawRow("evt-1")]);
    const res = await transformPendingOwnedEvents();
    expect(applyOwnedOrder).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ processed: 1, facts: 2, dlq: 0 });
    expect(fake.calls.updates.some((u) => u.table === "raw_owned_event")).toBe(true);
  });

  it("skips an unknown event type without dispatching", async () => {
    await load([rawRow("evt-2", "SOMETHING_ELSE")]);
    const res = await transformPendingOwnedEvents();
    expect(applyOwnedOrder).not.toHaveBeenCalled();
    expect(res.processed).toBe(1);
    expect(res.facts).toBe(0);
  });

  it("routes an apply failure to the DLQ and still stamps processed_at (no loop)", async () => {
    applyOwnedOrder.mockRejectedValueOnce(new Error("boom"));
    await load([rawRow("evt-3")]);
    const res = await transformPendingOwnedEvents();
    expect(res.dlq).toBe(1);
    const dlq = fake.calls.inserts.find((i) => i.table === "ingestion_dlq");
    expect(dlq).toBeTruthy();
    const dlqRow = dlq!.rows as Record<string, unknown>;
    expect(dlqRow.error_kind).toBeTruthy();
    expect(dlqRow.shop_id).toBe(SHOP);
    expect(fake.calls.updates.some((u) => u.table === "raw_owned_event")).toBe(true);
  });
});
