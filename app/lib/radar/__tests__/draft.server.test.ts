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

function genericCompetitorPriceCandidate(): RadarCandidate {
  return {
    kind: "competitor_price",
    dedupKey: "comp-price:c1",
    headline: "Pricing changed at Rival Gear",
    rationale: "Rival Gear changed prices on 2 pages. Take a look and decide if your own pricing still stands up.",
    evidence: {
      chips: ["Rival Gear", "2 pages changed"],
      facts: { competitorId: "c1", pages: [], pricingClaim: "generic" },
    },
    payload: { applyMode: "review", deepLink: "/dashboard/products", competitorId: "c1", url: "https://rival.example/" },
  };
}

function labeledCompetitorPriceCandidate(): RadarCandidate {
  return {
    kind: "competitor_price",
    dedupKey: "comp-price:c2",
    headline: "Rival Gear changed their prices",
    rationale: "Boots: $129.00 is now $99.00 at Rival Gear. Worth a quick look at your own prices - nothing changes unless you decide to.",
    evidence: {
      chips: ["Rival Gear", "Boots: was $129.00", "now $99.00"],
      facts: {
        competitorId: "c2",
        pages: [],
        priceChanges: [{ label: "Boots", from: "$129.00", to: "$99.00" }],
        pricingClaim: "labeled",
      },
    },
    payload: { applyMode: "review", deepLink: "/dashboard/products", competitorId: "c2", url: "https://rival.example/products/boots" },
  };
}

/** No pricingClaim marker at all - e.g. an older detector version, a bug, or a
 *  future move kind that forgets to set it. Fail-closed: this must be treated
 *  the same as "generic", never as "labeled". */
function unlabeledCompetitorPriceCandidate(): RadarCandidate {
  return {
    kind: "competitor_price",
    dedupKey: "comp-price:c3",
    headline: "Pricing changed at Rival Gear",
    rationale: "Rival Gear changed prices on 2 pages. Take a look and decide if your own pricing still stands up.",
    evidence: {
      chips: ["Rival Gear", "2 pages changed"],
      facts: { competitorId: "c3", pages: [] },
    },
    payload: { applyMode: "review", deepLink: "/dashboard/products", competitorId: "c3", url: "https://rival.example/" },
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

  describe("competitor_price polish gate (FIX 4 - never let Claude pair unlabeled prices)", () => {
    it("never sends a generic (unpaired) competitor_price candidate to Claude and keeps the deterministic copy", async () => {
      mocks.detectAll.mockReturnValue([genericCompetitorPriceCandidate()]);
      const out = await draftShopMoves(SHOP);
      expect(mocks.checkAiQuota).not.toHaveBeenCalled();
      expect(mocks.createMock).not.toHaveBeenCalled();
      expect(mocks.insertDraftMove).toHaveBeenCalledTimes(1);
      expect(mocks.insertDraftMove.mock.calls[0][1]).toMatchObject({
        headline: "Pricing changed at Rival Gear",
        rationale: "Rival Gear changed prices on 2 pages. Take a look and decide if your own pricing still stands up.",
      });
      expect(out).toMatchObject({ drafted: 1, polished: 0 });
    });
    it("fails closed: a competitor_price candidate with NO pricingClaim marker is never sent to Claude", async () => {
      mocks.detectAll.mockReturnValue([unlabeledCompetitorPriceCandidate()]);
      const out = await draftShopMoves(SHOP);
      expect(mocks.checkAiQuota).not.toHaveBeenCalled();
      expect(mocks.createMock).not.toHaveBeenCalled();
      expect(mocks.insertDraftMove).toHaveBeenCalledTimes(1);
      expect(mocks.insertDraftMove.mock.calls[0][1]).toMatchObject({
        headline: "Pricing changed at Rival Gear",
        rationale: "Rival Gear changed prices on 2 pages. Take a look and decide if your own pricing still stands up.",
      });
      expect(out).toMatchObject({ drafted: 1, polished: 0 });
    });
    it("still polishes a labeled competitor_price candidate", async () => {
      mocks.detectAll.mockReturnValue([labeledCompetitorPriceCandidate()]);
      const out = await draftShopMoves(SHOP);
      expect(mocks.checkAiQuota).toHaveBeenCalledTimes(1);
      expect(mocks.createMock).toHaveBeenCalledTimes(1);
      expect(mocks.insertDraftMove.mock.calls[0][1]).toMatchObject({ headline: "Polished" });
      expect(out).toMatchObject({ drafted: 1, polished: 1 });
    });
    it("does not spend an attempt-cap slot on a generic candidate, leaving the cap for others", async () => {
      mocks.detectAll.mockReturnValue([
        genericCompetitorPriceCandidate(),
        ...([1, 2, 3, 4, 5].map(candidate)),
      ]);
      const out = await draftShopMoves(SHOP);
      // 5 candidates worth of real Claude attempts, none spent on the generic one.
      expect(mocks.createMock).toHaveBeenCalledTimes(RADAR_NIGHTLY_CLAUDE_CAP);
      expect(out).toMatchObject({ drafted: 6, polished: RADAR_NIGHTLY_CLAUDE_CAP });
    });
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
