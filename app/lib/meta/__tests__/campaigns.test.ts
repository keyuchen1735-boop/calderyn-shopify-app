import { describe, it, expect, vi } from "vitest";
import { listCampaigns, setCampaignStatus, getCampaignStatus, type MetaClient } from "../campaigns.server";
import { fetchCampaignInsights, setCampaignBudget } from "../campaigns.server";

function fakeClient(over: Partial<MetaClient> = {}): MetaClient {
  return {
    get: vi.fn(async () => ({ data: [] })),
    post: vi.fn(async () => ({ success: true })),
    ...over,
  };
}

describe("listCampaigns", () => {
  it("requests the account campaigns and maps fields", async () => {
    const get = vi.fn(async () => ({
      data: [
        { id: "120", name: "Prospecting", status: "ACTIVE", effective_status: "ACTIVE", daily_budget: "1500" },
        { id: "121", name: "Retarget", status: "PAUSED", effective_status: "PAUSED" },
      ],
    }));
    const client = fakeClient({ get });
    const rows = await listCampaigns(client, "act_99");
    expect(get).toHaveBeenCalledWith("/act_99/campaigns", {
      fields: "id,name,status,effective_status,daily_budget",
    });
    expect(rows).toEqual([
      { id: "120", name: "Prospecting", status: "ACTIVE", effectiveStatus: "ACTIVE", dailyBudgetCents: 1500 },
      { id: "121", name: "Retarget", status: "PAUSED", effectiveStatus: "PAUSED", dailyBudgetCents: null },
    ]);
  });

  it("throws on a Graph error payload", async () => {
    const client = fakeClient({ get: vi.fn(async () => ({ error: { message: "Invalid token", code: 190 } })) });
    await expect(listCampaigns(client, "act_99")).rejects.toThrow(/Invalid token/);
  });
});

describe("setCampaignStatus", () => {
  it("posts the status to the campaign", async () => {
    const post = vi.fn(async () => ({ success: true }));
    await setCampaignStatus(fakeClient({ post }), "120", "PAUSED");
    expect(post).toHaveBeenCalledWith("/120", { status: "PAUSED" });
  });

  it("throws on a Graph error payload", async () => {
    const client = fakeClient({ post: vi.fn(async () => ({ error: { message: "Permission denied", code: 200 } })) });
    await expect(setCampaignStatus(client, "120", "ACTIVE")).rejects.toThrow(/Permission denied/);
  });
});

describe("getCampaignStatus", () => {
  it("reads the campaign's current status", async () => {
    const get = vi.fn(async () => ({ id: "120", status: "ARCHIVED" }));
    const status = await getCampaignStatus(fakeClient({ get }), "120");
    expect(get).toHaveBeenCalledWith("/120", { fields: "status" });
    expect(status).toBe("ARCHIVED");
  });

  it("throws on a Graph error payload", async () => {
    const client = fakeClient({ get: vi.fn(async () => ({ error: { message: "Unknown id", code: 100 } })) });
    await expect(getCampaignStatus(client, "999")).rejects.toThrow(/Unknown id/);
  });
});

describe("fetchCampaignInsights", () => {
  it("parses spend->cents and the purchase_roas array (omni_purchase pick), missing -> 0", async () => {
    const get = vi.fn(async () => ({
      data: [
        { campaign_id: "120", spend: "50.00", purchase_roas: [{ action_type: "omni_purchase", value: "3.12" }] },
        { campaign_id: "121", spend: "12.34" },
      ],
    }));
    const out = await fetchCampaignInsights(fakeClient({ get }), "act_99");
    expect(get).toHaveBeenCalledWith("/act_99/insights", {
      level: "campaign", date_preset: "last_7d", fields: "campaign_id,spend,purchase_roas",
    });
    expect(out).toEqual({
      "120": { spend7dCents: 5000, roas7d: 3.12 },
      "121": { spend7dCents: 1234, roas7d: 0 },
    });
  });

  it("follows pagination cursors", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({
        data: [{ campaign_id: "1", spend: "1.00" }],
        paging: { next: "http://next", cursors: { after: "CUR2" } },
      })
      .mockResolvedValueOnce({ data: [{ campaign_id: "2", spend: "2.00" }] });
    const out = await fetchCampaignInsights(fakeClient({ get }), "act_1");
    expect(get).toHaveBeenNthCalledWith(2, "/act_1/insights", {
      level: "campaign", date_preset: "last_7d", fields: "campaign_id,spend,purchase_roas", after: "CUR2",
    });
    expect(Object.keys(out)).toEqual(["1", "2"]);
  });

  it("throws on a Graph error payload", async () => {
    const client = fakeClient({ get: vi.fn(async () => ({ error: { message: "Bad account", code: 100 } })) });
    await expect(fetchCampaignInsights(client, "act_99")).rejects.toThrow(/Bad account/);
  });
});

describe("setCampaignBudget", () => {
  it("posts the daily_budget in cents as a string", async () => {
    const post = vi.fn(async () => ({ success: true }));
    await setCampaignBudget(fakeClient({ post }), "120", 4000);
    expect(post).toHaveBeenCalledWith("/120", { daily_budget: "4000" });
  });

  it("throws on a Graph error payload", async () => {
    const client = fakeClient({ post: vi.fn(async () => ({ error: { message: "Cannot set budget", code: 200 } })) });
    await expect(setCampaignBudget(client, "120", 4000)).rejects.toThrow(/Cannot set budget/);
  });
});
