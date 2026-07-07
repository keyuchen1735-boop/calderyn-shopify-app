import { describe, it, expect, vi, beforeEach } from "vitest";

const { isAuthorizedCronMock, listConnectedShopIdsMock, syncRankingsMock } = vi.hoisted(() => ({
  isAuthorizedCronMock: vi.fn(),
  listConnectedShopIdsMock: vi.fn(),
  syncRankingsMock: vi.fn(),
}));

vi.mock("~/lib/cron-auth.server", () => ({ isAuthorizedCron: isAuthorizedCronMock }));
vi.mock("~/lib/seo/google-search-console.server", () => ({
  listConnectedShopIds: listConnectedShopIdsMock,
  syncRankings: syncRankingsMock,
}));

// eslint-disable-next-line import/first -- imports must follow vi.mock
import { loader } from "../cron.seo-rankings";

function req() {
  return new Request("https://app.x/cron/seo-rankings", { headers: { authorization: "Bearer test" } });
}

beforeEach(() => { vi.clearAllMocks(); });

describe("cron.seo-rankings", () => {
  it("401s when the bearer check fails", async () => {
    isAuthorizedCronMock.mockReturnValue(false);
    const res = (await loader({ request: req() } as never)) as Response;
    expect(res.status).toBe(401);
    expect(listConnectedShopIdsMock).not.toHaveBeenCalled();
  });

  it("syncs every connected shop and returns a summary", async () => {
    isAuthorizedCronMock.mockReturnValue(true);
    listConnectedShopIdsMock.mockResolvedValue(["s1", "s2"]);
    syncRankingsMock.mockResolvedValueOnce({ upserted: 3 }).mockResolvedValueOnce({ upserted: 0 });
    const res = (await loader({ request: req() } as never)) as Response;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.synced).toEqual([{ shopId: "s1", upserted: 3 }, { shopId: "s2", upserted: 0 }]);
    expect(body.errors).toEqual([]);
  });

  it("isolates a per-shop failure without aborting the rest", async () => {
    isAuthorizedCronMock.mockReturnValue(true);
    listConnectedShopIdsMock.mockResolvedValue(["s1", "s2"]);
    syncRankingsMock.mockRejectedValueOnce(new Error("token revoked")).mockResolvedValueOnce({ upserted: 1 });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = (await loader({ request: req() } as never)) as Response;
    const body = await res.json();
    expect(body.synced).toEqual([{ shopId: "s2", upserted: 1 }]);
    expect(body.errors).toEqual(["s1: token revoked"]);
    spy.mockRestore();
  });

  it("returns a clean zero summary when no shops are connected", async () => {
    isAuthorizedCronMock.mockReturnValue(true);
    listConnectedShopIdsMock.mockResolvedValue([]);
    const res = (await loader({ request: req() } as never)) as Response;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ synced: [], errors: [] });
    expect(syncRankingsMock).not.toHaveBeenCalled();
  });
});
