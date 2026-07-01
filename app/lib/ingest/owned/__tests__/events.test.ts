import { describe, it, expect } from "vitest";
import { parseOwnedCheckoutCompleted, OWNED_CHECKOUT_COMPLETED } from "../events";

const SHOP = "00000000-0000-0000-0000-000000000001";

function validEvent(): Record<string, unknown> {
  return {
    event_id: "evt-1",
    type: OWNED_CHECKOUT_COMPLETED,
    shop_id: SHOP,
    occurred_at: "2026-06-30T12:00:00.000Z",
    order: {
      external_id: "owned-order-1",
      order_number: "#1001",
      total_cents: 2500,
      subtotal_cents: 2000,
      shipping_cents: 400,
      tax_cents: 100,
      discount_cents: 0,
      currency: "USD",
      financial_status: "paid",
      buyer_id: "11111111-1111-1111-1111-111111111111",
    },
    lines: [
      { external_line_id: "l1", variant_id: "22222222-2222-2222-2222-222222222222", quantity: 1, price_cents: 2000, total_cents: 2000, grams: 500 },
    ],
  };
}

describe("parseOwnedCheckoutCompleted", () => {
  it("parses a valid paid checkout event", () => {
    const e = parseOwnedCheckoutCompleted(validEvent());
    expect(e.event_id).toBe("evt-1");
    expect(e.order.buyer_id).toBe("11111111-1111-1111-1111-111111111111");
    expect(e.lines).toHaveLength(1);
    expect(e.lines[0].variant_id).toBe("22222222-2222-2222-2222-222222222222");
  });

  it("allows a null buyer_id (guest with no captured identity)", () => {
    const raw = validEvent();
    (raw.order as Record<string, unknown>).buyer_id = null;
    expect(parseOwnedCheckoutCompleted(raw).order.buyer_id).toBeNull();
  });

  it("throws when a PII key is present anywhere in the payload", () => {
    const raw = validEvent();
    (raw.order as Record<string, unknown>).email = "leak@example.com";
    expect(() => parseOwnedCheckoutCompleted(raw)).toThrow(/PII/i);
  });

  it("throws when financial_status is not 'paid'", () => {
    const raw = validEvent();
    (raw.order as Record<string, unknown>).financial_status = "pending";
    expect(() => parseOwnedCheckoutCompleted(raw)).toThrow(/paid/);
  });

  it("throws when a required numeric field is missing", () => {
    const raw = validEvent();
    delete (raw.order as Record<string, unknown>).total_cents;
    expect(() => parseOwnedCheckoutCompleted(raw)).toThrow(/total_cents/);
  });
});
