import { beforeEach, describe, expect, it, vi } from "vitest";

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }));
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ from: fromMock }) }));

// eslint-disable-next-line import/first
import {
  expireStaleMoves,
  getMove,
  insertDraftMove,
  isCoolingDown,
  listMoves,
  stampRadarState,
  updateMove,
} from "../store.server";
// eslint-disable-next-line import/first
import type { RadarCandidate, RadarMoveRow } from "../types";

const SHOP = "11111111-2222-3333-4444-555555555555";
const NOW = new Date("2026-07-20T10:00:00Z");

const CANDIDATE: RadarCandidate = {
  kind: "seo_meta_rewrite",
  dedupKey: "ctr-low:u:q",
  headline: "h",
  rationale: "r",
  evidence: { chips: [], facts: {} },
  payload: { applyMode: "publish_meta" },
};

function row(patch: Partial<RadarMoveRow>): RadarMoveRow {
  return {
    id: "m1", shopId: SHOP, kind: "seo_meta_rewrite", status: "draft",
    headline: "h", rationale: "r", evidence: { chips: [], facts: {} },
    payload: {}, dedupKey: "ctr-low:u:q", priorState: null, appliedStateHash: null,
    createdAt: "2026-07-19T00:00:00Z", appliedAt: null, resolvedAt: null,
    expiresAt: "2026-08-02T00:00:00Z", ...patch,
  };
}

beforeEach(() => { vi.clearAllMocks(); });

describe("isCoolingDown", () => {
  it("blocks on an open draft, a 30-day dismissal and a 14-day expiry", () => {
    expect(isCoolingDown([row({ status: "draft" })], CANDIDATE, NOW)).toBe(true);
    expect(isCoolingDown([row({ status: "dismissed", resolvedAt: "2026-07-01T00:00:00Z" })], CANDIDATE, NOW)).toBe(true);
    expect(isCoolingDown([row({ status: "expired", resolvedAt: "2026-07-10T00:00:00Z" })], CANDIDATE, NOW)).toBe(true);
    expect(isCoolingDown([row({ status: "applied", appliedAt: "2026-07-15T00:00:00Z" })], CANDIDATE, NOW)).toBe(true);
  });
  it("lets the cooldowns lapse and ignores other dedup keys", () => {
    expect(isCoolingDown([row({ status: "dismissed", resolvedAt: "2026-06-01T00:00:00Z" })], CANDIDATE, NOW)).toBe(false);
    expect(isCoolingDown([row({ status: "expired", resolvedAt: "2026-07-01T00:00:00Z" })], CANDIDATE, NOW)).toBe(false);
    expect(isCoolingDown([row({ status: "draft", dedupKey: "other" })], CANDIDATE, NOW)).toBe(false);
    expect(isCoolingDown([row({ status: "draft", kind: "seo_content_boost" })], CANDIDATE, NOW)).toBe(false);
  });
});

describe("insertDraftMove", () => {
  it("inserts and reports a duplicate-key race as 'duplicate'", async () => {
    const insert = vi.fn().mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: { code: "23505", message: "dup" } })
      .mockResolvedValueOnce({ error: { code: "XX000", message: "down" } });
    fromMock.mockReturnValue({ insert });
    await expect(insertDraftMove(SHOP, CANDIDATE)).resolves.toBe("inserted");
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      shop_id: SHOP, kind: "seo_meta_rewrite", status: "draft",
      dedup_key: "ctr-low:u:q", headline: "h", rationale: "r",
    }));
    await expect(insertDraftMove(SHOP, CANDIDATE)).resolves.toBe("duplicate");
    await expect(insertDraftMove(SHOP, CANDIDATE)).rejects.toThrow(/down/);
  });
});

describe("row reads and transitions", () => {
  it("maps snake_case rows to RadarMoveRow", async () => {
    const chain = {
      select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(), gte: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({
        data: [{
          id: "m1", shop_id: SHOP, kind: "section_refresh", status: "draft",
          headline: "h", rationale: "r", evidence: { chips: ["a"], facts: {} },
          payload: { applyMode: "refresh_section" }, dedup_key: "stale:home",
          prior_state: null, applied_state_hash: null,
          created_at: "c", applied_at: null, resolved_at: null, expires_at: "e",
        }],
        error: null,
      }),
    };
    fromMock.mockReturnValue(chain);
    const rows = await listMoves(SHOP, ["draft"]);
    expect(rows).toEqual([expect.objectContaining({
      id: "m1", shopId: SHOP, kind: "section_refresh", dedupKey: "stale:home",
      payload: { applyMode: "refresh_section" }, createdAt: "c", expiresAt: "e",
    })]);
    expect(chain.in).toHaveBeenCalledWith("status", ["draft"]);
  });
  it("getMove scopes by shop and id", async () => {
    const MOVE_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const eq2 = vi.fn().mockReturnValue({ maybeSingle });
    const eq1 = vi.fn().mockReturnValue({ eq: eq2 });
    const select = vi.fn().mockReturnValue({ eq: eq1 });
    fromMock.mockReturnValue({ select });
    await expect(getMove(SHOP, MOVE_ID)).resolves.toBeNull();
    expect(eq1).toHaveBeenCalledWith("shop_id", SHOP);
    expect(eq2).toHaveBeenCalledWith("id", MOVE_ID);
  });
  it("updateMove writes only the mapped columns", async () => {
    const MOVE_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const eqId = vi.fn().mockResolvedValue({ error: null });
    const eqShop = vi.fn().mockReturnValue({ eq: eqId });
    const update = vi.fn().mockReturnValue({ eq: eqShop });
    fromMock.mockReturnValue({ update });
    await updateMove(SHOP, MOVE_ID, { status: "applied", appliedAt: "t", priorState: { a: 1 }, appliedStateHash: "x" });
    expect(update).toHaveBeenCalledWith({
      status: "applied", applied_at: "t", prior_state: { a: 1 }, applied_state_hash: "x",
    });
  });
  it("updateMove with expectedStatus conditions the write and reports whether it took", async () => {
    const MOVE_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const select = vi.fn().mockResolvedValue({ data: [{ id: MOVE_ID }], error: null });
    const eqStatus = vi.fn().mockReturnValue({ select });
    const eqId = vi.fn().mockReturnValue({ eq: eqStatus });
    const eqShop = vi.fn().mockReturnValue({ eq: eqId });
    const update = vi.fn().mockReturnValue({ eq: eqShop });
    fromMock.mockReturnValue({ update });
    await expect(updateMove(SHOP, MOVE_ID, { status: "applied" }, "draft")).resolves.toBe(true);
    expect(eqStatus).toHaveBeenCalledWith("status", "draft");
    expect(select).toHaveBeenCalledWith("id");

    select.mockResolvedValue({ data: [], error: null });
    await expect(updateMove(SHOP, MOVE_ID, { status: "applied" }, "draft")).resolves.toBe(false);
  });
  it("expireStaleMoves sweeps open drafts past their expiry", async () => {
    const select = vi.fn().mockResolvedValue({ data: [{ id: "m1" }, { id: "m2" }], error: null });
    const lt = vi.fn().mockReturnValue({ select });
    const eqStatus = vi.fn().mockReturnValue({ lt });
    const eqShop = vi.fn().mockReturnValue({ eq: eqStatus });
    const update = vi.fn().mockReturnValue({ eq: eqShop });
    fromMock.mockReturnValue({ update });
    await expect(expireStaleMoves(SHOP, NOW)).resolves.toBe(2);
    expect(update).toHaveBeenCalledWith({ status: "expired", resolved_at: NOW.toISOString() });
    expect(lt).toHaveBeenCalledWith("expires_at", NOW.toISOString());
  });
  it("stampRadarState upserts the requested cursor fields", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    fromMock.mockReturnValue({ upsert });
    await stampRadarState(SHOP, { lastDraftedAt: "t1", homeCardDismissedAt: "t2" });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ shop_id: SHOP, last_drafted_at: "t1", home_card_dismissed_at: "t2" }),
      { onConflict: "shop_id" },
    );
  });
});
