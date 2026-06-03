import { describe, it, expect, vi } from "vitest";
import { backfillMetaShop, windowRange } from "../backfill.server";

describe("windowRange", () => {
  it("returns an inclusive since..until of `days` ending today", () => {
    const { since, until } = windowRange(90, new Date("2026-06-02T00:00:00Z"));
    expect(until).toBe("2026-06-02");
    expect(since).toBe("2026-03-04"); // 90 days earlier
  });
});

describe("backfillMetaShop", () => {
  it("upserts campaign + ad facts/dims from fetched insights", async () => {
    const upserts: Record<string, unknown[]> = {};
    const deps = {
      shopId: "shop-1",
      adAccountId: "act_9",
      fetchInsights: vi.fn(async (_c: unknown, _a: string, q: { level: string }) =>
        q.level === "campaign"
          ? [{ campaign_id: "120", campaign_name: "Prospecting", date_start: "2026-05-01", spend: "10.00", action_values: [{ action_type: "omni_purchase", value: "30.00" }] }]
          : [{ ad_id: "777", ad_name: "Hero", adset_id: "5", campaign_id: "120", date_start: "2026-05-01", spend: "10.00", actions: [{ action_type: "post_reaction", value: "4" }] }],
      ),
      client: { get: vi.fn(), post: vi.fn() },
      upsert: vi.fn(async (table: string, rows: unknown[]) => {
        upserts[table] = (upserts[table] ?? []).concat(rows);
      }),
      now: new Date("2026-06-02T00:00:00Z"),
    };

    const res = await backfillMetaShop(deps);

    expect(deps.fetchInsights).toHaveBeenCalledTimes(2);
    expect(upserts["ad_campaign_dim"]).toEqual([{ shop_id: "shop-1", external_id: "120", name: "Prospecting" }]);
    expect(upserts["ad_spend_fact"][0]).toMatchObject({ campaign_external_id: "120", spend_cents: 1000, purchase_value_cents: 3000 });
    expect(upserts["ad_dim"][0]).toMatchObject({ external_id: "777", campaign_external_id: "120" });
    expect(upserts["ad_insight_fact"][0]).toMatchObject({ ad_external_id: "777", reactions: 4 });
    expect(res).toMatchObject({ campaignFacts: 1, adFacts: 1 });
  });
});
