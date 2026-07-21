import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getMove: vi.fn(),
  updateMove: vi.fn(),
  applySeoMeta: vi.fn(),
  revertSeoMeta: vi.fn(),
  applyOrgRefresh: vi.fn(),
  revertOrgRefresh: vi.fn(),
  applySectionRefresh: vi.fn(),
  revertSectionRefresh: vi.fn(),
}));
vi.mock("../store.server", () => ({ getMove: mocks.getMove, updateMove: mocks.updateMove }));
vi.mock("../apply-seo.server", async (importActual) => ({
  ...(await importActual() as Record<string, unknown>),
  applySeoMeta: mocks.applySeoMeta,
  revertSeoMeta: mocks.revertSeoMeta,
  applyOrgRefresh: mocks.applyOrgRefresh,
  revertOrgRefresh: mocks.revertOrgRefresh,
}));
vi.mock("../apply-section.server", () => ({
  applySectionRefresh: mocks.applySectionRefresh,
  revertSectionRefresh: mocks.revertSectionRefresh,
}));

// eslint-disable-next-line import/first -- vitest vi.hoisted() requires mocks before imports
import { applyMove, dismissMove, revertMove } from "../apply.server";
// eslint-disable-next-line import/first -- vitest vi.hoisted() requires mocks before imports
import type { RadarMoveRow } from "../types";

const SHOP = "11111111-2222-3333-4444-555555555555";
const MOVE_ID = "99999999-1111-2222-3333-444444444444";

function row(patch: Partial<RadarMoveRow>): RadarMoveRow {
  return {
    id: MOVE_ID, shopId: SHOP, kind: "seo_meta_rewrite", status: "draft",
    headline: "h", rationale: "r", evidence: { chips: [], facts: {} },
    payload: { applyMode: "publish_meta" }, dedupKey: "d",
    priorState: null, appliedStateHash: null,
    createdAt: "c", appliedAt: null, resolvedAt: null, expiresAt: "e", ...patch,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updateMove.mockResolvedValue(undefined);
  mocks.applySeoMeta.mockResolvedValue({ priorState: { kind: "seo_meta" }, appliedStateHash: "hash" });
});

describe("applyMove", () => {
  it("dispatches publish_meta, persists the outcome and returns the applied row", async () => {
    mocks.getMove.mockResolvedValue(row({}));
    const out = await applyMove({ shopId: SHOP, moveId: MOVE_ID, actorId: "u1" });
    expect(mocks.applySeoMeta).toHaveBeenCalledWith(SHOP, expect.objectContaining({ id: MOVE_ID }), "u1");
    expect(mocks.updateMove).toHaveBeenCalledWith(SHOP, MOVE_ID, expect.objectContaining({
      status: "applied", appliedAt: expect.any(String),
      priorState: { kind: "seo_meta" }, appliedStateHash: "hash",
    }));
    expect(out.status).toBe("applied");
  });
  it("review moves apply without touching the store", async () => {
    mocks.getMove.mockResolvedValue(row({ payload: { applyMode: "review", deepLink: "/dashboard/store/preferences" } }));
    await applyMove({ shopId: SHOP, moveId: MOVE_ID, actorId: null });
    expect(mocks.applySeoMeta).not.toHaveBeenCalled();
    expect(mocks.applySectionRefresh).not.toHaveBeenCalled();
    expect(mocks.updateMove).toHaveBeenCalledWith(SHOP, MOVE_ID, expect.objectContaining({ status: "applied", priorState: null }));
  });
  it("dispatches refresh_section and refresh_org", async () => {
    mocks.applySectionRefresh.mockResolvedValue({ priorState: { kind: "section" }, appliedStateHash: "v" });
    mocks.getMove.mockResolvedValue(row({ kind: "section_refresh", payload: { applyMode: "refresh_section", brief: "b" } }));
    await applyMove({ shopId: SHOP, moveId: MOVE_ID, actorId: null });
    expect(mocks.applySectionRefresh).toHaveBeenCalled();
    mocks.applyOrgRefresh.mockResolvedValue({ priorState: { kind: "org" }, appliedStateHash: "o" });
    mocks.getMove.mockResolvedValue(row({ kind: "aeo_refresh", payload: { applyMode: "refresh_org" } }));
    await applyMove({ shopId: SHOP, moveId: MOVE_ID, actorId: null });
    expect(mocks.applyOrgRefresh).toHaveBeenCalled();
  });
  it("404s an unknown move and 409s a non-draft move", async () => {
    mocks.getMove.mockResolvedValue(null);
    await expect(applyMove({ shopId: SHOP, moveId: MOVE_ID, actorId: null }))
      .rejects.toMatchObject({ code: "move_not_found", status: 404 });
    mocks.getMove.mockResolvedValue(row({ status: "applied" }));
    await expect(applyMove({ shopId: SHOP, moveId: MOVE_ID, actorId: null }))
      .rejects.toMatchObject({ code: "move_not_open", status: 409 });
  });
  it("leaves the move draft when the executor fails", async () => {
    mocks.getMove.mockResolvedValue(row({}));
    mocks.applySeoMeta.mockRejectedValue(new Error("upstream down"));
    await expect(applyMove({ shopId: SHOP, moveId: MOVE_ID, actorId: null })).rejects.toThrow(/upstream down/);
    expect(mocks.updateMove).not.toHaveBeenCalled();
  });
});

describe("dismissMove", () => {
  it("marks a draft dismissed with a resolution time", async () => {
    mocks.getMove.mockResolvedValue(row({}));
    const out = await dismissMove({ shopId: SHOP, moveId: MOVE_ID });
    expect(mocks.updateMove).toHaveBeenCalledWith(SHOP, MOVE_ID, {
      status: "dismissed", resolvedAt: expect.any(String),
    });
    expect(out.status).toBe("dismissed");
  });
});

describe("revertMove", () => {
  it("dispatches by prior-state kind and marks the move reverted", async () => {
    mocks.getMove.mockResolvedValue(row({
      status: "applied",
      priorState: { kind: "section", runtime: 1, priorPublishedVersionId: "v0", appliedVersionId: "v1" },
      appliedStateHash: "v1",
    }));
    await revertMove({ shopId: SHOP, moveId: MOVE_ID, actorId: "u1", confirm: false });
    expect(mocks.revertSectionRefresh).toHaveBeenCalledWith(
      SHOP, expect.anything(), { confirm: false }, "u1",
    );
    expect(mocks.updateMove).toHaveBeenCalledWith(SHOP, MOVE_ID, expect.objectContaining({
      status: "dismissed", resolvedAt: expect.any(String),
      payload: expect.objectContaining({ reverted: true }),
    }));
  });
  it("refuses to revert a review move or a non-applied move", async () => {
    mocks.getMove.mockResolvedValue(row({ status: "applied", priorState: null }));
    await expect(revertMove({ shopId: SHOP, moveId: MOVE_ID, actorId: null, confirm: false }))
      .rejects.toMatchObject({ code: "nothing_to_revert" });
    mocks.getMove.mockResolvedValue(row({ status: "draft" }));
    await expect(revertMove({ shopId: SHOP, moveId: MOVE_ID, actorId: null, confirm: false }))
      .rejects.toMatchObject({ code: "move_not_applied", status: 409 });
  });
});
