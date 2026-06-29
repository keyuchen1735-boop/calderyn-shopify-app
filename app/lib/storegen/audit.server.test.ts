// app/lib/storegen/audit.server.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { recordGeneration, recordProposal } from "./audit.server";

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }));
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ from: fromMock }) }));

const realShop = "11111111-1111-1111-1111-111111111111";
beforeEach(() => fromMock.mockReset());

describe("generation audit repo", () => {
  it("recordGeneration inserts a run row", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    fromMock.mockReturnValue({ insert });
    await recordGeneration({ shopId: realShop, runId: "r1", source: "catalog", briefText: null, model: "claude-haiku-4-5", status: "draft", tokenCost: 42 });
    expect(fromMock).toHaveBeenCalledWith("store_generation");
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ shop_id: realShop, run_id: "r1", status: "draft", token_cost: 42 }));
  });
  it("recordProposal upserts the raw plan json", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    fromMock.mockReturnValue({ upsert });
    await recordProposal(realShop, "r1", { home: { blocks: [] } });
    expect(fromMock).toHaveBeenCalledWith("store_generation_proposal");
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ run_id: "r1", shop_id: realShop }), { onConflict: "run_id" });
  });
  it("skips the DB for a non-uuid (demo) shop", async () => {
    await recordGeneration({ shopId: "demo-shop", runId: "r1", source: "catalog", briefText: null, model: "m", status: "draft", tokenCost: 0 });
    expect(fromMock).not.toHaveBeenCalled();
  });
});
