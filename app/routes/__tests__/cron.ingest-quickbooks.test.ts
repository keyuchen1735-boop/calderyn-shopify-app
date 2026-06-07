import { describe, it, expect, vi, beforeEach } from "vitest";

const listShopIntegrations = vi.fn();
const quickbooksClientForShop = vi.fn();
const syncQuickbooksCogs = vi.fn();
const statusPatches: Array<{ patch: Record<string, unknown> }> = [];
const dlqInserts: Array<Record<string, unknown>> = [];

vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: (table: string) => {
      if (table === "shop_integrations") {
        return {
          select: () => ({ in: () => ({ in: async () => ({ data: listShopIntegrations(), error: null }) }) }),
          update: (patch: Record<string, unknown>) => {
            statusPatches.push({ patch });
            return { eq: () => ({ eq: async () => ({ error: null }) }) };
          },
        };
      }
      if (table === "ingestion_dlq") {
        return { insert: (row: Record<string, unknown>) => { dlqInserts.push(row); return Promise.resolve({ error: null }); } };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));
vi.mock("~/lib/quickbooks/client.server", () => ({
  quickbooksClientForShop: (...a: unknown[]) => quickbooksClientForShop(...a),
}));
vi.mock("~/lib/quickbooks/ingest.server", () => ({
  syncQuickbooksCogs: (...a: unknown[]) => syncQuickbooksCogs(...a),
}));

import { loader } from "../cron.ingest-quickbooks";

beforeEach(() => {
  statusPatches.length = 0;
  dlqInserts.length = 0;
  listShopIntegrations.mockReset();
  quickbooksClientForShop.mockReset();
  syncQuickbooksCogs.mockReset();
  process.env.CRON_SECRET = "s3cret";
});

function req(auth?: string) {
  const headers = new Headers();
  if (auth) headers.set("authorization", auth);
  return { request: new Request("https://app.example/cron.ingest-quickbooks", { headers }) } as Parameters<typeof loader>[0];
}

describe("cron.ingest-quickbooks", () => {
  it("rejects without the cron bearer", async () => {
    const res = await loader(req());
    expect(res.status).toBe(401);
  });

  it("syncs each connected shop and reports counts", async () => {
    listShopIntegrations.mockReturnValue([{ shop_id: "shop-1" }]);
    quickbooksClientForShop.mockResolvedValue({ realmId: "r", client: { queryItems: vi.fn() } });
    syncQuickbooksCogs.mockResolvedValue({ matched: 2, inserted: 1, updated: 1, unchanged: 0, skippedNoMatch: 0 });

    const res = await loader(req("Bearer s3cret"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.synced).toContainEqual(expect.objectContaining({ shopId: "shop-1", inserted: 1, updated: 1 }));
    expect(statusPatches.some((p) => p.patch.sync_status === "live")).toBe(true);
    expect(dlqInserts).toHaveLength(0);
  });

  it("records a DLQ row + error status when a shop sync throws", async () => {
    listShopIntegrations.mockReturnValue([{ shop_id: "shop-1" }]);
    quickbooksClientForShop.mockResolvedValue({ realmId: "r", client: { queryItems: vi.fn() } });
    syncQuickbooksCogs.mockRejectedValue(new Error("boom"));

    const res = await loader(req("Bearer s3cret"));
    const body = await res.json();
    expect(body.errors).toHaveLength(1);
    expect(dlqInserts[0]).toMatchObject({ shop_id: "shop-1", connector: "quickbooks" });
    expect(statusPatches.some((p) => p.patch.sync_status === "error")).toBe(true);
  });

  it("skips shops with no usable credential (client is null)", async () => {
    listShopIntegrations.mockReturnValue([{ shop_id: "shop-1" }]);
    quickbooksClientForShop.mockResolvedValue(null);
    const res = await loader(req("Bearer s3cret"));
    const body = await res.json();
    expect(body.skipped).toContain("shop-1");
    expect(syncQuickbooksCogs).not.toHaveBeenCalled();
  });
});
