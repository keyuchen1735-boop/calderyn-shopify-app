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
import { StoreCommandError } from "~/lib/storefront-command/command.server";
// eslint-disable-next-line import/first -- vitest vi.hoisted() requires mocks before imports
import { sanitizeDocHtml } from "~/lib/storebuilder/sanitize-html.server";
// eslint-disable-next-line import/first -- vitest vi.hoisted() requires mocks before imports
import type { BlockDocument } from "~/lib/storebuilder/types";
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

// Single-quoted style attribute: sanitize-html always re-serializes attributes double-quoted, so
// this document is guaranteed to come out of sanitizeDocHtml byte-different from how it went in -
// the fixture that proves the apply-time hash must be computed post-sanitize (finding 2).
const RAWHTML_DOC = {
  kind: "singleton", pageKey: "home",
  blocks: [{
    id: "b1", type: "rawHtml",
    props: { html: "<section style='padding:1rem'><h2>Old headline</h2><p>Old body</p></section>" },
    layout: { x: 0, y: 0, w: 12, h: 4 },
  }],
};

/** Simulates a Postgres jsonb round trip: canonicalizes object key order without touching
 *  values, so a test can prove code hashes what a live re-read will actually produce rather than
 *  the in-memory object as originally constructed (jsonb reorders keys on write; JS object
 *  literals preserve insertion order, so the two can byte-differ under JSON.stringify). */
function reorderKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => reorderKeys(v)) as unknown as T;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).reverse();
    return Object.fromEntries(entries.map(([k, v]) => [k, reorderKeys(v)])) as T;
  }
  return value;
}

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
  it("rejects an empty or whitespace-only brief before touching the store", async () => {
    mocks.runStoreCommand.mockReset();
    await expect(applySectionRefresh(SHOP, move({ brief: "   " }), "u1"))
      .rejects.toMatchObject({ code: "bad_payload", status: 422 });
    expect(mocks.runStoreCommand).not.toHaveBeenCalled();
  });
  it("surfaces the receipt's own message when the prompt stage reports unchanged", async () => {
    mocks.runStoreCommand.mockReset();
    mocks.runStoreCommand.mockResolvedValueOnce({ status: "unchanged", message: "Nothing to change." });
    await expect(applySectionRefresh(SHOP, move({}), "u1"))
      .rejects.toMatchObject({ code: "section_apply_failed", status: 422, message: "Nothing to change." });
    expect(mocks.runStoreCommand).toHaveBeenCalledTimes(1); // no publish attempt, no undo attempt
  });
  it("best-effort undoes the orphaned draft when the publish stage fails after prompt succeeds", async () => {
    mocks.runStoreCommand.mockReset();
    mocks.runStoreCommand
      .mockResolvedValueOnce({ status: "installed", versionId: V_NEW, undo: { targetVersionId: V_PUB, expectedDraftVersionId: V_NEW } })
      .mockRejectedValueOnce(new StoreCommandError("storefront_command_failed", "publish boom", 500))
      .mockResolvedValueOnce({ status: "installed", versionId: V_PUB, undo: null });
    await expect(applySectionRefresh(SHOP, move({}), "u1"))
      .rejects.toMatchObject({ code: "storefront_command_failed", status: 500 });
    expect(mocks.runStoreCommand).toHaveBeenCalledTimes(3);
    expect(mocks.runStoreCommand).toHaveBeenNthCalledWith(3, {
      shopId: SHOP, actorId: "u1",
      command: { kind: "undo", targetVersionId: V_PUB, expectedDraftVersionId: V_NEW },
    });
  });
  it("swallows an undo failure and still surfaces the original publish error", async () => {
    mocks.runStoreCommand.mockReset();
    mocks.runStoreCommand
      .mockResolvedValueOnce({ status: "installed", versionId: V_NEW, undo: { targetVersionId: V_PUB, expectedDraftVersionId: V_NEW } })
      .mockRejectedValueOnce(new StoreCommandError("storefront_command_failed", "publish boom", 500))
      .mockRejectedValueOnce(new Error("undo also failed"));
    await expect(applySectionRefresh(SHOP, move({}), "u1"))
      .rejects.toMatchObject({ code: "storefront_command_failed", status: 500 });
  });
  it("does not attempt an undo when the prompt stage never installed a draft", async () => {
    mocks.runStoreCommand.mockReset();
    mocks.runStoreCommand.mockRejectedValueOnce(new StoreCommandError("storefront_command_conflict", "conflict", 409));
    await expect(applySectionRefresh(SHOP, move({}), "u1"))
      .rejects.toMatchObject({ code: "storefront_command_conflict", status: 409 });
    expect(mocks.runStoreCommand).toHaveBeenCalledTimes(1);
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
    expect(mocks.checkAiQuota).toHaveBeenCalledWith({ shopId: SHOP, feature: "radar_apply", trusted: true });
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
  it("rejects an empty or whitespace-only brief before generating copy", async () => {
    await expect(applySectionRefresh(SHOP, move({ brief: "   " }), null))
      .rejects.toMatchObject({ code: "bad_payload", status: 422 });
    expect(mocks.createMock).not.toHaveBeenCalled();
  });
  it("refuses a legacy pdp target regardless of publish state - the defensive backstop for a move drafted before the legacy-pdp downgrade existed", async () => {
    // Even if a pdp page happens to be published, applying would overwrite the
    // shop-wide template with one product's copy - must fail before any read.
    mocks.loadPublishedDoc.mockResolvedValue(HOME_DOC);
    await expect(applySectionRefresh(SHOP, move({ target: "pdp" }), "u1"))
      .rejects.toMatchObject({
        status: 422,
        message: "Product pages share one layout on this store. Open the store builder to update it.",
      });
    expect(mocks.loadPublishedDoc).not.toHaveBeenCalled();
    expect(mocks.createMock).not.toHaveBeenCalled();
    expect(mocks.saveDraft).not.toHaveBeenCalled();
  });
  it("escapes the headline and never treats it as a replacement pattern (rawHtml path)", async () => {
    mocks.loadPublishedDoc.mockResolvedValue(RAWHTML_DOC);
    mocks.createMock.mockResolvedValue({
      content: [{ type: "text", text: '{"headline":"Save $2 today & more","subhead":"Fresh subhead"}' }],
    });
    await applySectionRefresh(SHOP, move({}), "u1");
    const savedDoc = mocks.saveDraft.mock.calls[0][2] as BlockDocument;
    const html = savedDoc.blocks[0].props.html as string;
    // Entity-escaped, and the "$2" inside the headline was never read as a capture-group
    // reference (which would have deleted the closing </h2> and corrupted the markup).
    expect(html).toBe('<section style=\'padding:1rem\'><h2>Save $2 today &amp; more</h2><p>Old body</p></section>');
    expect(html).not.toContain("$1");
    expect(html).not.toContain("$&");
  });
  it("hashes what a live re-read returns post-publish, not the in-memory doc, so an untouched revert never demands confirm (rawHtml path)", async () => {
    mocks.loadPublishedDoc.mockImplementation(async () => {
      if (!mocks.saveDraft.mock.calls.length) return RAWHTML_DOC; // this apply's initial load
      // Post-publish re-read: what's actually live is sanitizeDocHtml applied to the doc
      // saveDraft received (single-quoted style attribute gets re-serialized double-quoted).
      const saved = mocks.saveDraft.mock.calls[0][2] as BlockDocument;
      return sanitizeDocHtml(saved);
    });
    const out = await applySectionRefresh(SHOP, move({}), "u1");
    const savedDoc = mocks.saveDraft.mock.calls[0][2] as BlockDocument;
    const actualPublished = sanitizeDocHtml(savedDoc);
    expect(sha256(savedDoc)).not.toBe(sha256(actualPublished)); // sanity: the sanitizer DID normalize something
    expect(out.appliedStateHash).toBe(sha256(actualPublished));

    const applied = move({}, {
      status: "applied",
      priorState: { kind: "section", runtime: 0, pageKey: "home", doc: RAWHTML_DOC },
      appliedStateHash: out.appliedStateHash,
    });
    await revertSectionRefresh(SHOP, applied, { confirm: false }, null); // must NOT throw revert_conflict
    expect(mocks.saveDraft).toHaveBeenCalledWith(SHOP, "home", RAWHTML_DOC);
  });
  it("does not false-conflict on revert when the live re-read comes back key-reordered (jsonb round-trip, hero path)", async () => {
    mocks.loadPublishedDoc.mockImplementation(async () => {
      if (!mocks.saveDraft.mock.calls.length) return HOME_DOC; // this apply's initial load
      // A real Postgres jsonb column canonicalizes object key order on write, so a live re-read
      // can come back key-reordered relative to whatever was constructed in memory before the
      // write - same values, different JSON.stringify bytes. The apply-time hash must be taken
      // from this same re-read path (not the pre-write in-memory doc) or every legitimate revert
      // of an untouched page would false-conflict.
      const saved = mocks.saveDraft.mock.calls[0][2] as BlockDocument;
      return reorderKeys(sanitizeDocHtml(saved));
    });
    const out = await applySectionRefresh(SHOP, move({}), "u1");

    const applied = move({}, {
      status: "applied",
      priorState: { kind: "section", runtime: 0, pageKey: "home", doc: HOME_DOC },
      appliedStateHash: out.appliedStateHash,
    });
    await revertSectionRefresh(SHOP, applied, { confirm: false }, null); // must NOT throw revert_conflict
    expect(mocks.saveDraft).toHaveBeenCalledWith(SHOP, "home", HOME_DOC);
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
  it("requires confirm when the merchant has unpublished draft edits, even if published is unchanged", async () => {
    const applied = move({}, {
      status: "applied",
      priorState: { kind: "section", runtime: 0, pageKey: "home", doc: HOME_DOC },
      appliedStateHash: sha256(HOME_DOC),
    });
    mocks.loadPublishedDoc.mockResolvedValue(HOME_DOC); // published unchanged since apply
    mocks.loadDraftDoc.mockResolvedValue({ ...HOME_DOC, blocks: [] }); // merchant has unpublished edits
    await expect(revertSectionRefresh(SHOP, applied, { confirm: false }, null))
      .rejects.toMatchObject({ code: "revert_conflict", status: 409 });
    expect(mocks.saveDraft).not.toHaveBeenCalled();
    await revertSectionRefresh(SHOP, applied, { confirm: true }, null);
    expect(mocks.saveDraft).toHaveBeenCalledWith(SHOP, "home", HOME_DOC);
  });
});
