import { describe, it, expect, vi } from "vitest";
import { listCampaignAdSets } from "../creatives.server";
import type { MetaClient } from "../campaigns.server";

function fakeClient(over: Partial<MetaClient> = {}): MetaClient {
  return {
    get: vi.fn(async () => ({ data: [] })),
    post: vi.fn(async () => ({ success: true })),
    ...over,
  };
}

describe("listCampaignAdSets", () => {
  it("requests the campaign's ad sets and maps id/name/status", async () => {
    const get = vi.fn(async () => ({
      data: [
        { id: "as1", name: "Prospecting", status: "ACTIVE" },
        { id: "as2", name: "Retarget", status: "PAUSED" },
      ],
    }));
    const rows = await listCampaignAdSets(fakeClient({ get }), "120");
    expect(get).toHaveBeenCalledWith("/120/adsets", { fields: "id,name,status" });
    expect(rows).toEqual([
      { id: "as1", name: "Prospecting", status: "ACTIVE" },
      { id: "as2", name: "Retarget", status: "PAUSED" },
    ]);
  });

  it("rejects a non-numeric campaign id (injection guard)", async () => {
    await expect(listCampaignAdSets(fakeClient(), "../evil")).rejects.toThrow(/Invalid Meta campaign id/);
  });

  it("throws on a Graph error payload", async () => {
    const get = vi.fn(async () => ({ error: { message: "Unknown id", code: 100 } }));
    await expect(listCampaignAdSets(fakeClient({ get }), "120")).rejects.toThrow(/Unknown id/);
  });
});
