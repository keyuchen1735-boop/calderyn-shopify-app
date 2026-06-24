import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { seedShippedAutopilotFeatures } from "../supabase.server";

describe("seedShippedAutopilotFeatures", () => {
  it("provisions exactly the three shipped pause features without overwriting existing state", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const sb = {
      from: vi.fn((table: string) => {
        expect(table).toBe("pair_calibration");
        return { upsert };
      }),
    } as unknown as SupabaseClient;

    await seedShippedAutopilotFeatures("shop-1", sb);

    const [rows, options] = upsert.mock.calls[0];
    expect(rows).toEqual([
      expect.objectContaining({
        shop_id: "shop-1",
        detector_id: "sku_stockout_vs_spend",
        action_kind: "pause_campaign",
        graduated: true,
        last_conf: 74,
      }),
      expect.objectContaining({
        shop_id: "shop-1",
        detector_id: "campaign_below_breakeven",
        action_kind: "pause_campaign",
        graduated: true,
        last_conf: 74,
      }),
      expect.objectContaining({
        shop_id: "shop-1",
        detector_id: "negative_unit_economics",
        action_kind: "pause_campaign",
        graduated: true,
        last_conf: 74,
      }),
    ]);
    expect(options).toEqual({
      onConflict: "shop_id,detector_id,action_kind",
      ignoreDuplicates: true,
    });
  });
});
