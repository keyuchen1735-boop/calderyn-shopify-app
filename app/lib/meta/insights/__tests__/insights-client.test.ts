import { describe, it, expect, vi } from "vitest";
import { fetchInsights, CAMPAIGN_FIELDS, AD_FIELDS } from "../insights-client.server";
import type { MetaClient } from "../../campaigns.server";

function fakeClient(pages: Array<Record<string, unknown>>): { client: MetaClient; get: ReturnType<typeof vi.fn> } {
  let i = 0;
  const get = vi.fn(async () => pages[i++] ?? { data: [] });
  return { client: { get, post: vi.fn() }, get };
}

describe("fetchInsights", () => {
  it("requests campaign-level insights with the agreed fields + params", async () => {
    const { client, get } = fakeClient([{ data: [{ campaign_id: "1" }] }]);
    const rows = await fetchInsights(client, "act_9", {
      level: "campaign",
      since: "2026-05-01",
      until: "2026-05-30",
    });
    expect(get).toHaveBeenCalledWith("/act_9/insights", {
      level: "campaign",
      fields: CAMPAIGN_FIELDS,
      time_increment: "1",
      time_range: JSON.stringify({ since: "2026-05-01", until: "2026-05-30" }),
      use_unified_attribution_setting: "true",
      action_report_time: "conversion",
      limit: "200",
    });
    expect(rows).toEqual([{ campaign_id: "1" }]);
  });

  it("uses AD_FIELDS at ad level and follows paging.next cursors", async () => {
    const { client, get } = fakeClient([
      { data: [{ ad_id: "a" }], paging: { next: "x", cursors: { after: "CUR2" } } },
      { data: [{ ad_id: "b" }] },
    ]);
    const rows = await fetchInsights(client, "act_9", { level: "ad", since: "2026-05-01", until: "2026-05-30" });
    expect(get.mock.calls[0][1]).toMatchObject({ fields: AD_FIELDS, level: "ad" });
    expect(get.mock.calls[1][1]).toMatchObject({ after: "CUR2" });
    expect(rows).toEqual([{ ad_id: "a" }, { ad_id: "b" }]);
  });

  it("throws on a Graph error payload", async () => {
    const client: MetaClient = { get: vi.fn(async () => ({ error: { message: "Rate limited", code: 17 } })), post: vi.fn() };
    await expect(
      fetchInsights(client, "act_9", { level: "campaign", since: "2026-05-01", until: "2026-05-30" }),
    ).rejects.toThrow(/Rate limited/);
  });
});
