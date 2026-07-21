import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  releaseState: vi.fn(),
  runStoreCommand: vi.fn(),
  rollback: vi.fn(),
  loadPublishedDoc: vi.fn(),
  loadDraftDoc: vi.fn(),
  saveDraft: vi.fn(),
  publishDoc: vi.fn(),
  validateDocument: vi.fn(),
  listProducts: vi.fn(),
  listCollections: vi.fn(),
  checkAiQuota: vi.fn(),
  createMock: vi.fn(),
}));
vi.mock("~/lib/storefront-bundle/build.server", () => ({ readStorefrontReleaseState: mocks.releaseState }));
vi.mock("~/lib/storefront-command/command.server", () => ({
  runStoreCommand: mocks.runStoreCommand,
  StoreCommandError: class StoreCommandError extends Error {
    constructor(public code: string, message: string, public status: number) { super(message); }
  },
}));
vi.mock("~/lib/storefront-bundle/release.server", () => ({ rollbackStorefrontRelease: mocks.rollback }));
vi.mock("~/lib/storebuilder/page-document.server", () => ({
  loadPublishedDoc: mocks.loadPublishedDoc,
  loadDraftDoc: mocks.loadDraftDoc,
  saveDraft: mocks.saveDraft,
  publishDoc: mocks.publishDoc,
}));
vi.mock("~/lib/storebuilder/validate", () => ({ validateDocument: mocks.validateDocument }));
vi.mock("~/lib/storefront/catalog.server", () => ({
  getCatalog: () => ({ listProducts: mocks.listProducts, listCollections: mocks.listCollections }),
}));
vi.mock("~/lib/ai-quota.server", () => ({ checkAiQuota: mocks.checkAiQuota }));
vi.mock("~/lib/assistant/anthropic.server", () => ({
  getAnthropic: () => ({ messages: { create: mocks.createMock } }),
  radarDraftModel: () => "test-model",
}));

// eslint-disable-next-line import/first -- vitest vi.hoisted() requires mocks before imports
import { applySectionRefresh, revertSectionRefresh } from "../apply-section.server";
// eslint-disable-next-line import/first -- vitest vi.hoisted() requires mocks before imports
import { sha256 } from "../apply-seo.server";
// eslint-disable-next-line import/first -- vitest vi.hoisted() requires mocks before imports
import type { RadarMoveRow } from "../types";

const SHOP = "11111111-2222-3333-4444-555555555555";
const V_PUB = "aaaaaaaa-1111-2222-3333-444444444444";
const V_NEW = "bbbbbbbb-1111-2222-3333-444444444444";
const V_PUB2 = "cccccccc-1111-2222-3333-444444444444";

const HOME_DOC = {
  kind: "singleton", pageKey: "home",
  blocks: [{ id: "b1", type: "hero", props: { headline: "Old headline", subhead: "Old subhead" }, layout: { x: 0, y: 0, w: 12, h: 4 } }],
};

function move(payload: Record<string, unknown>, patch: Partial<RadarMoveRow> = {}): RadarMoveRow {
  return {
    id: "m1", shopId: SHOP, kind: "section_refresh", status: "draft",
    headline: "h", rationale: "r", evidence: { chips: [], facts: {} },
    payload: { applyMode: "refresh_section", target: "home", brief: "Refresh the hero.", ...payload },
    dedupKey: "stale:home", priorState: null, appliedStateHash: null,
    createdAt: "c", appliedAt: null, resolvedAt: null, expiresAt: "e", ...patch,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.checkAiQuota.mockResolvedValue({ allowed: true });
  mocks.createMock.mockResolvedValue({ content: [{ type: "text", text: '{"headline":"Fresh headline","subhead":"Fresh subhead"}' }] });
  mocks.listProducts.mockResolvedValue([]);
  mocks.listCollections.mockResolvedValue([]);
  mocks.validateDocument.mockImplementation((doc: unknown) => ({ doc, dropped: [], missingFunctional: [] }));
});

describe("runtime 1", () => {
  beforeEach(() => {
    mocks.releaseState.mockResolvedValue({
      draftVersionId: V_PUB, publishedVersionId: V_PUB,
      draftRuntimeVersion: 1, publishedRuntimeVersion: 1,
    });
    mocks.runStoreCommand
      .mockResolvedValueOnce({ status: "installed", versionId: V_NEW, undo: null })
      .mockResolvedValueOnce({ status: "published", versionId: V_NEW });
  });
  it("runs prompt then publish through runStoreCommand and records version pointers", async () => {
    const out = await applySectionRefresh(SHOP, move({}), "u1");
    expect(mocks.runStoreCommand).toHaveBeenNthCalledWith(1, {
      shopId: SHOP, actorId: "u1",
      command: { kind: "prompt", prompt: "Refresh the hero.", expectedDraftVersionId: V_PUB },
    });
    expect(mocks.runStoreCommand).toHaveBeenNthCalledWith(2, {
      shopId: SHOP, actorId: "u1",
      command: { kind: "publish", expectedDraftVersionId: V_NEW },
    });
    expect(out.priorState).toEqual({ kind: "section", runtime: 1, priorPublishedVersionId: V_PUB, appliedVersionId: V_NEW });
    expect(out.appliedStateHash).toBe(V_NEW);
    expect(mocks.createMock).not.toHaveBeenCalled(); // runtime 1 generates inside its own pipeline
  });
  it("refuses to touch an unpublished merchant draft", async () => {
    mocks.releaseState.mockResolvedValue({
      draftVersionId: V_NEW, publishedVersionId: V_PUB,
      draftRuntimeVersion: 1, publishedRuntimeVersion: 1,
    });
    mocks.runStoreCommand.mockReset();
    await expect(applySectionRefresh(SHOP, move({}), null))
      .rejects.toMatchObject({ code: "draft_in_progress", status: 409 });
    expect(mocks.runStoreCommand).not.toHaveBeenCalled();
  });
  it("reverts via rollbackStorefrontRelease with the current published pointer", async () => {
    mocks.releaseState.mockResolvedValue({
      draftVersionId: V_NEW, publishedVersionId: V_NEW,
      draftRuntimeVersion: 1, publishedRuntimeVersion: 1,
    });
    const applied = move({}, {
      status: "applied",
      priorState: { kind: "section", runtime: 1, priorPublishedVersionId: V_PUB, appliedVersionId: V_NEW },
      appliedStateHash: V_NEW,
    });
    await revertSectionRefresh(SHOP, applied, { confirm: false }, "u1");
    expect(mocks.rollback).toHaveBeenCalledWith({
      shopId: SHOP, targetVersionId: V_PUB, expectedPublishedVersionId: V_NEW, actorId: "u1",
    });
  });
  it("requires confirm when the store was published again since apply", async () => {
    mocks.releaseState.mockResolvedValue({
      draftVersionId: V_PUB2, publishedVersionId: V_PUB2,
      draftRuntimeVersion: 1, publishedRuntimeVersion: 1,
    });
    const applied = move({}, {
      status: "applied",
      priorState: { kind: "section", runtime: 1, priorPublishedVersionId: V_PUB, appliedVersionId: V_NEW },
      appliedStateHash: V_NEW,
    });
    await expect(revertSectionRefresh(SHOP, applied, { confirm: false }, null))
      .rejects.toMatchObject({ code: "revert_conflict", status: 409 });
    await revertSectionRefresh(SHOP, applied, { confirm: true }, null);
    expect(mocks.rollback).toHaveBeenCalledWith(expect.objectContaining({ expectedPublishedVersionId: V_PUB2 }));
  });
});

describe("legacy runtime", () => {
  beforeEach(() => {
    mocks.releaseState.mockResolvedValue({
      draftVersionId: null, publishedVersionId: null,
      draftRuntimeVersion: null, publishedRuntimeVersion: null,
    });
    mocks.loadPublishedDoc.mockResolvedValue(HOME_DOC);
    mocks.loadDraftDoc.mockResolvedValue(null);
    mocks.saveDraft.mockResolvedValue(undefined);
    mocks.publishDoc.mockResolvedValue(undefined);
  });
  it("rewrites the hero copy via quota-gated Claude, validates, publishes and hashes", async () => {
    const out = await applySectionRefresh(SHOP, move({}), "u1");
    expect(mocks.checkAiQuota).toHaveBeenCalledWith({ shopId: SHOP, feature: "radar", trusted: true });
    expect(mocks.saveDraft).toHaveBeenCalledWith(SHOP, "home", expect.objectContaining({
      blocks: [expect.objectContaining({ props: { headline: "Fresh headline", subhead: "Fresh subhead" } })],
    }));
    expect(mocks.publishDoc).toHaveBeenCalledWith(SHOP, "home");
    expect(out.priorState).toMatchObject({ kind: "section", runtime: 0, pageKey: "home", doc: HOME_DOC });
    expect(out.appliedStateHash).toHaveLength(64);
  });
  it("refuses when a legacy draft diverges from published, and when Claude fails", async () => {
    mocks.loadDraftDoc.mockResolvedValue({ ...HOME_DOC, blocks: [] });
    await expect(applySectionRefresh(SHOP, move({}), null))
      .rejects.toMatchObject({ code: "draft_in_progress", status: 409 });
    mocks.loadDraftDoc.mockResolvedValue(null);
    mocks.createMock.mockRejectedValue(new Error("api down"));
    await expect(applySectionRefresh(SHOP, move({}), null))
      .rejects.toMatchObject({ code: "section_copy_failed" });
    expect(mocks.publishDoc).not.toHaveBeenCalled();
  });
  it("reverts by republishing the stored doc after a clean hash check", async () => {
    const applied = move({}, {
      status: "applied",
      priorState: { kind: "section", runtime: 0, pageKey: "home", doc: HOME_DOC },
      appliedStateHash: sha256(HOME_DOC),
    });
    mocks.loadPublishedDoc.mockResolvedValue(HOME_DOC); // unchanged since apply
    await revertSectionRefresh(SHOP, applied, { confirm: false }, null);
    expect(mocks.saveDraft).toHaveBeenCalledWith(SHOP, "home", HOME_DOC);
    expect(mocks.publishDoc).toHaveBeenCalledWith(SHOP, "home");
    // Edited since apply -> confirm required.
    mocks.loadPublishedDoc.mockResolvedValue({ ...HOME_DOC, blocks: [] });
    await expect(revertSectionRefresh(SHOP, applied, { confirm: false }, null))
      .rejects.toMatchObject({ code: "revert_conflict", status: 409 });
  });
});
