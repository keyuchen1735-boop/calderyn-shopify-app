import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildPoDraft, derivePoQuantity, getCurrentUnitCostCents } from "../draft.server";
import {
  buildChain,
  setSupabaseResponses,
  getRecorded,
} from "../../__tests__/_supabase_chain_mock";

describe("buildPoDraft", () => {
  it("builds a complete PO payload from alert facts, quantity and unit cost", () => {
    const po = buildPoDraft({
      alertId: "0f3b2a1c-9d8e-4f00-aaaa-bbbbccccdddd",
      detectorId: "reorder_timing",
      shopDomain: "peak-pine.myshopify.com",
      sku: "WND-BRK-S",
      title: "Trailhead Windbreaker — S",
      quantity: 120,
      unitCostCents: 2350,
      now: new Date("2026-06-09T15:00:00Z"),
    });

    // Deterministic, human-readable PO number derived from date + alert id.
    expect(po.po_number).toBe("PO-20260609-0F3B2A1C");
    expect(po.issued_at).toBe("2026-06-09T15:00:00.000Z");
    expect(po.shop_domain).toBe("peak-pine.myshopify.com");
    expect(po.alert_id).toBe("0f3b2a1c-9d8e-4f00-aaaa-bbbbccccdddd");
    expect(po.detector_id).toBe("reorder_timing");

    expect(po.lines).toEqual([
      {
        sku: "WND-BRK-S",
        title: "Trailhead Windbreaker — S",
        quantity: 120,
        unit_cost_cents: 2350,
      },
    ]);
    expect(po.subtotal_cents).toBe(120 * 2350);
    expect(po.total_cents).toBe(120 * 2350);
  });

  it("keeps totals null (TBD) when unit cost is unknown — never silently $0", () => {
    const po = buildPoDraft({
      alertId: "0f3b2a1c-9d8e-4f00-aaaa-bbbbccccdddd",
      detectorId: "reorder_timing",
      shopDomain: "peak-pine.myshopify.com",
      sku: "WND-BRK-S",
      title: "Trailhead Windbreaker — S",
      quantity: 120,
      unitCostCents: null,
      now: new Date("2026-06-09T15:00:00Z"),
    });

    expect(po.lines[0].unit_cost_cents).toBeNull();
    expect(po.subtotal_cents).toBeNull();
    expect(po.total_cents).toBeNull();
  });
});

describe("derivePoQuantity", () => {
  it("uses shortfall_units when present (regional_shortage_risk), rounded up", () => {
    // Engine emits decimals as strings, e.g. "37.4".
    expect(derivePoQuantity({ shortfall_units: "37.4", lead_time_days: 14 })).toBe(38);
  });

  it("falls back to daily velocity × lead time (reorder_timing evidence)", () => {
    expect(
      derivePoQuantity({ daily_velocity_units: "5.71", lead_time_days: 14 }),
    ).toBe(80); // ceil(5.71 × 14) = ceil(79.94)
  });

  it("accepts velocity_units_per_day and defaults lead time to 14 days (scaling_sku_fulfillment_risk)", () => {
    expect(derivePoQuantity({ velocity_units_per_day: "3" })).toBe(42);
  });

  it("returns null when evidence has no usable quantity signal", () => {
    expect(derivePoQuantity({ days_of_cover: "2.0" })).toBeNull();
  });
});

describe("getCurrentUnitCostCents", () => {
  const sb = () => buildChain() as unknown as SupabaseClient;

  it("returns the open cogs_fact unit cost for the shop's sku code", async () => {
    setSupabaseResponses([
      { data: { id: "sku-uuid-1" }, error: null }, // sku_dim lookup by code
      { data: { unit_cost_cents: 2350 }, error: null }, // open cogs_fact row
    ]);

    const cents = await getCurrentUnitCostCents(sb(), "shop-uuid-1", "WND-BRK-S");

    expect(cents).toBe(2350);
    // Both lookups must be shop-scoped.
    expect(getRecorded("eq")).toEqual(
      expect.arrayContaining([
        ["shop_id", "shop-uuid-1"],
        ["sku", "WND-BRK-S"],
        ["sku_id", "sku-uuid-1"],
      ]),
    );
  });

  it("returns null when the sku or an open cost row is missing", async () => {
    setSupabaseResponses([{ data: null, error: null }]);
    expect(await getCurrentUnitCostCents(sb(), "shop-uuid-1", "NOPE")).toBeNull();
  });
});
