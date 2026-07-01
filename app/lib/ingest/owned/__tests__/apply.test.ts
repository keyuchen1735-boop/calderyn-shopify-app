import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as ApplyServer from "../apply.server";
import { makeFakeSupabase } from "./fake-supabase";
import { OWNED_CHECKOUT_COMPLETED } from "../events";

const fake = makeFakeSupabase({ upsertReturns: { order_fact: { id: "order-uuid" } } });
vi.mock("../../../supabase.server", () => ({ getSupabase: () => fake.client }));
// applyAttribution reaches Supabase itself; stub it and assert the call args.
const applyAttribution = vi.fn().mockResolvedValue(undefined);
vi.mock("../../../attribution/apply.server", () => ({ applyAttribution: (...a: unknown[]) => applyAttribution(...a) }));

let applyOwnedOrder: typeof ApplyServer.applyOwnedOrder;
const SHOP = "00000000-0000-0000-0000-000000000001";
const VARIANT = "22222222-2222-2222-2222-222222222222";
const BUYER = "11111111-1111-1111-1111-111111111111";

function event() {
  return {
    event_id: "evt-1", type: OWNED_CHECKOUT_COMPLETED, shop_id: SHOP,
    occurred_at: "2026-06-30T12:00:00.000Z",
    order: {
      external_id: "owned-order-1", order_number: "#1001", total_cents: 2500,
      subtotal_cents: 2000, shipping_cents: 400, tax_cents: 100, discount_cents: 0,
      currency: "USD", financial_status: "paid" as const, buyer_id: BUYER,
      attribution: { utm: { utm_source: "meta" }, clickIds: {}, referringSite: "https://ig.example" },
    },
    lines: [{ external_line_id: "l1", variant_id: VARIANT, quantity: 1, price_cents: 2000, total_cents: 2000, grams: 500 }],
  };
}

beforeEach(async () => {
  fake.calls.upserts.length = 0; applyAttribution.mockClear();
  ({ applyOwnedOrder } = await import("../apply.server"));
});

describe("applyOwnedOrder", () => {
  it("writes order_fact with buyer_id and NO PII column", async () => {
    await applyOwnedOrder(event() as never);
    const of = fake.calls.upserts.find((u) => u.table === "order_fact")!;
    const row = of.rows as Record<string, unknown>;
    expect(row.buyer_id).toBe(BUYER);
    expect(row.external_id).toBe("owned-order-1");
    expect(row.utm_source).toBe("meta");
    for (const k of ["email", "phone", "name", "address", "shipping_address"]) {
      expect(row).not.toHaveProperty(k);
    }
    expect(of.opts).toMatchObject({ onConflict: "shop_id,external_id" });
  });

  it("writes order_line_fact with sku_id = variant_id (repo invariant)", async () => {
    await applyOwnedOrder(event() as never);
    const lf = fake.calls.upserts.find((u) => u.table === "order_line_fact")!;
    const rows = lf.rows as Array<Record<string, unknown>>;
    expect(rows[0].sku_id).toBe(VARIANT);
    expect(rows[0].order_id).toBe("order-uuid");
    expect(lf.opts).toMatchObject({ onConflict: "order_id,external_line_id" });
  });

  it("invokes applyAttribution with the order's signals and revenue", async () => {
    await applyOwnedOrder(event() as never);
    expect(applyAttribution).toHaveBeenCalledTimes(1);
    const [shopId, orderId, revenue, signals] = applyAttribution.mock.calls[0];
    expect(shopId).toBe(SHOP);
    expect(orderId).toBe("order-uuid");
    expect(revenue).toBe(2500);
    expect(signals).toMatchObject({ utm: { utm_source: "meta" }, referringSite: "https://ig.example" });
  });
});
