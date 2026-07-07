import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { writeWeatherAlert } from "../alert-writer.server";
import type { WeatherAlertDraft } from "../drafts";

const draft: WeatherAlertDraft = {
  entityRef: { campaign_id: "src" }, severity: "medium", dollarImpact: 40,
  rank: 50, narrative: "n", evidence: { amount_cents: 4000 },
};

describe("writeWeatherAlert", () => {
  it("calls the RPC with the mapped column args and returns the id", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "alert-1", error: null });
    const sb = { rpc } as unknown as SupabaseClient;
    const id = await writeWeatherAlert(sb, "shop-1", "2026-07-07", draft);
    expect(id).toBe("alert-1");
    expect(rpc).toHaveBeenCalledWith("upsert_weather_alert", {
      p_shop_id: "shop-1", p_detector_id: "weather_demand",
      p_entity_ref: { campaign_id: "src" }, p_severity: "medium",
      p_dollar_impact: 40, p_day_bucket: "2026-07-07",
      p_narrative: "n", p_rank: 50, p_evidence: { amount_cents: 4000 },
    });
  });
  it("throws on rpc error", async () => {
    const sb = { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } }) } as never;
    await expect(writeWeatherAlert(sb, "s", "2026-07-07", draft)).rejects.toThrow("boom");
  });
});
