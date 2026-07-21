import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadRadarInputs: vi.fn(),
  detectAll: vi.fn(),
  expireStaleMoves: vi.fn(),
  listRecentMoveRows: vi.fn(),
  insertDraftMove: vi.fn(),
  isCoolingDown: vi.fn(),
  stampRadarState: vi.fn(),
  checkAiQuota: vi.fn(),
  createMock: vi.fn(),
}));
vi.mock("../collect.server", () => ({ loadRadarInputs: mocks.loadRadarInputs }));
vi.mock("../detect.server", () => ({ detectAll: mocks.detectAll }));
vi.mock("../store.server", () => ({
  expireStaleMoves: mocks.expireStaleMoves,
  listRecentMoveRows: mocks.listRecentMoveRows,
  insertDraftMove: mocks.insertDraftMove,
  isCoolingDown: mocks.isCoolingDown,
  stampRadarState: mocks.stampRadarState,
}));
vi.mock("~/lib/ai-quota.server", () => ({ checkAiQuota: mocks.checkAiQuota }));
vi.mock("~/lib/assistant/anthropic.server", () => ({
  getAnthropic: () => ({ messages: { create: mocks.createMock } }),
  radarDraftModel: () => "test-model",
}));

// eslint-disable-next-line import/first -- import must follow vi.mock so the drafter fakes register first
import { draftShopMoves, RADAR_NIGHTLY_CLAUDE_CAP } from "../draft.server";
// eslint-disable-next-line import/first -- import must follow vi.mock so the drafter fakes register first
import type { RadarCandidate } from "../types";

const SHOP = "11111111-2222-3333-4444-555555555555";

function candidate(n: number): RadarCandidate {
  return {
    kind: "seo_meta_rewrite",
    dedupKey: `c${n}`,
    headline: `Template headline ${n}`,
    rationale: `Template rationale ${n}`,
    evidence: { chips: [], facts: { n } },
    payload: { applyMode: "publish_meta" },
  };
}

function claudeReply(text: string) {
  return { content: [{ type: "text", text }] };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadRadarInputs.mockResolvedValue({});
  mocks.expireStaleMoves.mockResolvedValue(0);
  mocks.listRecentMoveRows.mockResolvedValue([]);
  mocks.insertDraftMove.mockResolvedValue("inserted");
  mocks.isCoolingDown.mockReturnValue(false);
  mocks.checkAiQuota.mockResolvedValue({ allowed: true });
  mocks.createMock.mockResolvedValue(claudeReply('{"headline":"Polished","rationale":"Better words."}'));
});

describe("draftShopMoves", () => {
  it("polishes at most 5 candidates, checking quota immediately before each call", async () => {
    mocks.detectAll.mockReturnValue([1, 2, 3, 4, 5, 6, 7].map(candidate));
    const out = await draftShopMoves(SHOP);
    expect(mocks.checkAiQuota).toHaveBeenCalledTimes(RADAR_NIGHTLY_CLAUDE_CAP);
    expect(mocks.checkAiQuota).toHaveBeenCalledWith({ shopId: SHOP, feature: "radar", trusted: true });
    expect(mocks.createMock).toHaveBeenCalledTimes(RADAR_NIGHTLY_CLAUDE_CAP);
    expect(mocks.insertDraftMove).toHaveBeenCalledTimes(7);
    // Polished copy on the first five, template copy on the rest.
    expect(mocks.insertDraftMove.mock.calls[0][1]).toMatchObject({ headline: "Polished" });
    expect(mocks.insertDraftMove.mock.calls[5][1]).toMatchObject({ headline: "Template headline 6" });
    expect(out).toMatchObject({ drafted: 7, polished: 5 });
  });
  it("quota denial stops Claude spend but drafting continues on templates", async () => {
    mocks.detectAll.mockReturnValue([1, 2, 3].map(candidate));
    mocks.checkAiQuota.mockResolvedValue({ allowed: false, code: "ai_daily_limit", message: "cap" });
    const out = await draftShopMoves(SHOP);
    expect(mocks.checkAiQuota).toHaveBeenCalledTimes(1);
    expect(mocks.createMock).not.toHaveBeenCalled();
    expect(out).toMatchObject({ drafted: 3, polished: 0 });
    expect(mocks.insertDraftMove.mock.calls[0][1]).toMatchObject({ headline: "Template headline 1" });
  });
  it("falls back to the template when Claude fails, returns junk, or says the internal word", async () => {
    mocks.detectAll.mockReturnValue([1, 2, 3].map(candidate));
    mocks.createMock
      .mockRejectedValueOnce(new Error("api down"))
      .mockResolvedValueOnce(claudeReply("not json"))
      .mockResolvedValueOnce(claudeReply('{"headline":"A clever ploy","rationale":"x"}'));
    const out = await draftShopMoves(SHOP);
    expect(out).toMatchObject({ drafted: 3, polished: 0 });
    for (const call of mocks.insertDraftMove.mock.calls) {
      expect(call[1].headline).toMatch(/^Template headline/);
    }
  });
  it("skips cooling-down candidates and counts duplicates as skipped", async () => {
    mocks.detectAll.mockReturnValue([1, 2].map(candidate));
    mocks.isCoolingDown.mockReturnValueOnce(true).mockReturnValueOnce(false);
    mocks.insertDraftMove.mockResolvedValueOnce("duplicate");
    const out = await draftShopMoves(SHOP);
    expect(mocks.insertDraftMove).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ drafted: 0, skipped: 2 });
  });
  it("sweeps expiry first and stamps the draft cursor last", async () => {
    mocks.detectAll.mockReturnValue([]);
    mocks.expireStaleMoves.mockResolvedValue(2);
    const out = await draftShopMoves(SHOP);
    expect(out.expired).toBe(2);
    expect(mocks.stampRadarState).toHaveBeenCalledWith(SHOP, { lastDraftedAt: expect.any(String) });
  });
});
