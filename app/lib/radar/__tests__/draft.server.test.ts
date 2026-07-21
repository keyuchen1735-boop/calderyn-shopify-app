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

function pdpCandidate(n: number): RadarCandidate {
  return {
    kind: "section_refresh",
    dedupKey: `pdp${n}`,
    headline: `Product ${n} lost visits`,
    rationale: `Product ${n} averaged 100 views a day but got 40 yesterday. A refreshed section can re-engage shoppers; nothing changes until you apply it.`,
    evidence: { chips: [`down`], facts: { n } },
    payload: {
      applyMode: "refresh_section", target: "pdp", handle: `product-${n}`, productId: `p${n}`,
      path: `/storefront/products/product-${n}`, brief: "Refresh this product page's top section.",
    },
  };
}

function homeCandidate(): RadarCandidate {
  return {
    kind: "section_refresh",
    dedupKey: "stale:home",
    headline: "Your home page hasn't changed in a while",
    rationale: "Your home page was last updated a while ago.",
    evidence: { chips: [], facts: {} },
    payload: { applyMode: "refresh_section", target: "home", path: "/storefront", brief: "Refresh the hero." },
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
  it("caps Claude attempts (not successes) at 5 even when polish fails", async () => {
    // 7 candidates, but cap should prevent attempts beyond 5
    mocks.detectAll.mockReturnValue([1, 2, 3, 4, 5, 6, 7].map(candidate));
    // Quota always allows
    mocks.checkAiQuota.mockResolvedValue({ allowed: true });
    // Polish fails on attempt 2, succeeds otherwise
    mocks.createMock
      .mockResolvedValueOnce(claudeReply('{"headline":"Polished 1","rationale":"Good."}'))
      .mockRejectedValueOnce(new Error("API error"))
      .mockResolvedValueOnce(claudeReply('{"headline":"Polished 3","rationale":"Good."}'))
      .mockResolvedValueOnce(claudeReply('{"headline":"Polished 4","rationale":"Good."}'))
      .mockResolvedValueOnce(claudeReply('{"headline":"Polished 5","rationale":"Good."}'));
    const out = await draftShopMoves(SHOP);
    // Should make exactly RADAR_NIGHTLY_CLAUDE_CAP (5) calls, not 6
    expect(mocks.checkAiQuota).toHaveBeenCalledTimes(RADAR_NIGHTLY_CLAUDE_CAP);
    expect(mocks.createMock).toHaveBeenCalledTimes(RADAR_NIGHTLY_CLAUDE_CAP);
    // Candidates 6 and 7 should use template copy
    expect(mocks.insertDraftMove.mock.calls[5][1]).toMatchObject({
      headline: "Template headline 6",
    });
    expect(mocks.insertDraftMove.mock.calls[6][1]).toMatchObject({
      headline: "Template headline 7",
    });
    // Candidate 2 also uses template (polish failed)
    expect(mocks.insertDraftMove.mock.calls[1][1]).toMatchObject({
      headline: "Template headline 2",
    });
    expect(out).toMatchObject({ drafted: 7, polished: 4 });
  });

  describe("legacy PDP downgrade", () => {
    // Deny quota so the polish step never overwrites the downgraded template copy -
    // these tests are about what the downgrade itself produces, not Claude's polish.
    beforeEach(() => {
      mocks.checkAiQuota.mockResolvedValue({ allowed: false, code: "ai_daily_limit", message: "cap" });
    });
    it("downgrades a product-specific pdp section_refresh to a review move when the storefront is on the legacy runtime", async () => {
      mocks.loadRadarInputs.mockResolvedValue({ publishedRuntimeVersion: null });
      mocks.detectAll.mockReturnValue([pdpCandidate(1)]);
      await draftShopMoves(SHOP);
      expect(mocks.insertDraftMove).toHaveBeenCalledTimes(1);
      const inserted = mocks.insertDraftMove.mock.calls[0][1];
      expect(inserted.payload).toEqual({ applyMode: "review", deepLink: "/dashboard/store" });
      expect(inserted.rationale).toMatch(/share one layout/i);
      expect(inserted.rationale).toMatch(/store builder/i);
      expect(mocks.createMock).not.toHaveBeenCalled(); // quota denied - never reaches Claude
    });
    it("downgrades the same way when the storefront has never published (unpublished, not runtime 1)", async () => {
      mocks.loadRadarInputs.mockResolvedValue({ publishedRuntimeVersion: undefined });
      mocks.detectAll.mockReturnValue([pdpCandidate(2)]);
      await draftShopMoves(SHOP);
      const inserted = mocks.insertDraftMove.mock.calls[0][1];
      expect(inserted.payload).toEqual({ applyMode: "review", deepLink: "/dashboard/store" });
    });
    it("leaves a pdp section_refresh untouched when the storefront is on runtime 1", async () => {
      mocks.loadRadarInputs.mockResolvedValue({ publishedRuntimeVersion: 1 });
      mocks.detectAll.mockReturnValue([pdpCandidate(3)]);
      await draftShopMoves(SHOP);
      const inserted = mocks.insertDraftMove.mock.calls[0][1];
      expect(inserted.payload).toMatchObject({ applyMode: "refresh_section", target: "pdp" });
    });
    it("leaves a non-pdp (home) section_refresh untouched even on the legacy runtime", async () => {
      mocks.loadRadarInputs.mockResolvedValue({ publishedRuntimeVersion: null });
      mocks.detectAll.mockReturnValue([homeCandidate()]);
      await draftShopMoves(SHOP);
      const inserted = mocks.insertDraftMove.mock.calls[0][1];
      expect(inserted.payload).toMatchObject({ applyMode: "refresh_section", target: "home" });
    });
  });
});
