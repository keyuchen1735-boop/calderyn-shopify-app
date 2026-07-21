import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ from: mocks.from }) }));

// eslint-disable-next-line import/first -- hoisted mocks must be defined before imports
import {
  insertSnapshot,
  insertSuggestion,
  latestSnapshots,
  listRecentDiffs,
  MAX_WATCHED_COMPETITORS,
  setCompetitorStatus,
} from "../competitor-store.server";

const SHOP = "11111111-1111-4111-8111-111111111111";
const COMP = "22222222-2222-4222-8222-222222222222";

/** Chainable supabase-query stub: every builder method returns itself and the
 *  chain is thenable, resolving the provided result. */
function chain(result: { data?: unknown; error?: unknown; count?: number | null }) {
  const target: Record<string, unknown> = {};
  const self = new Proxy(target, {
    get(_t, prop) {
      if (prop === "then") {
        return (resolve: (v: unknown) => unknown) =>
          resolve({ data: result.data ?? null, error: result.error ?? null, count: result.count ?? null });
      }
      return (..._args: unknown[]) => self;
    },
  });
  return self as never;
}

beforeEach(() => vi.clearAllMocks());

describe("insertSuggestion", () => {
  it("inserts a suggested row and reports 23505 as duplicate", async () => {
    mocks.from.mockReturnValueOnce(chain({}));
    const first = await insertSuggestion(SHOP, {
      url: "https://rival.example/", name: "Rival", evidence: { reason: "similar boots" },
    });
    expect(first).toBe("inserted");
    mocks.from.mockReturnValueOnce(chain({ error: { code: "23505", message: "dup" } }));
    const second = await insertSuggestion(SHOP, {
      url: "https://rival.example/", name: "Rival", evidence: {},
    });
    expect(second).toBe("duplicate");
  });
  it("refuses fixture (non-uuid) shops", async () => {
    await expect(insertSuggestion("demo-shop", { url: "https://x/", name: "", evidence: {} }))
      .rejects.toThrow(/uuid/);
    expect(mocks.from).not.toHaveBeenCalled();
  });
});

describe("setCompetitorStatus", () => {
  it("enforces the 5-watched cap before flipping to watching", async () => {
    mocks.from.mockReturnValueOnce(chain({ count: MAX_WATCHED_COMPETITORS })); // count query
    const res = await setCompetitorStatus(SHOP, COMP, "watching");
    expect(res).toBe("limit_reached");
    expect(MAX_WATCHED_COMPETITORS).toBe(5);
  });
  it("updates below the cap and reports not_found for a missing row", async () => {
    mocks.from
      .mockReturnValueOnce(chain({ count: 1 }))              // count
      .mockReturnValueOnce(chain({ data: [{ id: COMP }] })); // update ... select
    expect(await setCompetitorStatus(SHOP, COMP, "watching")).toBe("updated");
    mocks.from.mockReturnValueOnce(chain({ data: [] }));     // dismiss: no count query
    expect(await setCompetitorStatus(SHOP, COMP, "dismissed")).toBe("not_found");
  });
});

describe("snapshots", () => {
  it("latestSnapshots keeps the newest row per url", async () => {
    mocks.from.mockReturnValueOnce(chain({
      data: [
        { url: "https://rival.example/", content_hash: "new", extracted: { title: "B" } },
        { url: "https://rival.example/", content_hash: "old", extracted: { title: "A" } },
      ],
    }));
    const map = await latestSnapshots(SHOP, COMP);
    expect(map.get("https://rival.example/")).toMatchObject({ contentHash: "new" });
  });
  it("insertSnapshot upserts on the (competitor, url, day) natural key", async () => {
    const upsert = vi.fn(() => chain({}));
    mocks.from.mockReturnValueOnce({ upsert } as never);
    await insertSnapshot(SHOP, {
      competitorId: COMP, url: "https://rival.example/", contentHash: "h",
      extracted: { title: "", metaDescription: "", headings: [], prices: [] }, diff: null,
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ shop_id: SHOP, competitor_id: COMP, content_hash: "h" }),
      { onConflict: "competitor_id,url,captured_day" },
    );
  });
  it("listRecentDiffs joins watching competitor names onto diff rows", async () => {
    mocks.from
      .mockReturnValueOnce(chain({ data: [{ id: COMP, name: "Rival", url: "https://rival.example/", status: "watching", shop_id: SHOP, discovery_evidence: {}, created_at: "", updated_at: "" }] }))
      .mockReturnValueOnce(chain({
        data: [{ competitor_id: COMP, url: "https://rival.example/", captured_at: "2026-07-20T02:00:00Z",
          diff: { titleChanged: null, newHeadings: ["Summer sale"], removedHeadings: [], newPrices: [], removedPrices: [] } }],
      }));
    const rows = await listRecentDiffs(SHOP);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ competitorId: COMP, competitorName: "Rival" });
    expect(rows[0].diff.newHeadings).toEqual(["Summer sale"]);
  });
});
