import { describe, it, expect, vi } from "vitest";
import { listCampaigns, setCampaignStatus, getCampaignStatus, type MetaClient } from "../campaigns.server";

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
