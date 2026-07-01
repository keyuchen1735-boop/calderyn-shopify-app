import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFakeSupabase } from "./fake-supabase";
import { OWNED_CHECKOUT_COMPLETED } from "../events";

const fake = makeFakeSupabase();
vi.mock("../../../supabase.server", () => ({ getSupabase: () => fake.client }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
let emitOwnedEvent: typeof import("../emit.server").emitOwnedEvent;

const SHOP = "00000000-0000-0000-0000-000000000001";
function event() {
  return {
    event_id: "evt-1", type: OWNED_CHECKOUT_COMPLETED, shop_id: SHOP,
    occurred_at: "2026-06-30T12:00:00.000Z",
    order: {
      external_id: "owned-order-1", order_number: "#1001", total_cents: 2500,
      subtotal_cents: 2000, shipping_cents: 400, tax_cents: 100, discount_cents: 0,
      currency: "USD", financial_status: "paid" as const, buyer_id: null,
    },
    lines: [{ external_line_id: "l1", variant_id: "22222222-2222-2222-2222-222222222222", quantity: 1, price_cents: 2000, total_cents: 2000 }],
  };
}

beforeEach(async () => {
  fake.calls.upserts.length = 0;
  ({ emitOwnedEvent } = await import("../emit.server"));
});

describe("emitOwnedEvent", () => {
  it("upserts the event into raw_owned_event with the idempotency conflict key", async () => {
    await emitOwnedEvent(event());
    expect(fake.calls.upserts).toHaveLength(1);
    const u = fake.calls.upserts[0];
    expect(u.table).toBe("raw_owned_event");
    expect(u.opts).toMatchObject({ onConflict: "shop_id,event_id", ignoreDuplicates: true });
    expect((u.rows as Record<string, unknown>).event_id).toBe("evt-1");
  });

  it("rejects an event that carries PII before any write", async () => {
    const bad = event();
    (bad.order as Record<string, unknown>).email = "leak@example.com";
    await expect(emitOwnedEvent(bad as never)).rejects.toThrow(/PII/i);
    expect(fake.calls.upserts).toHaveLength(0);
  });
});
