// app/lib/storebuilder/page-document.server.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadPublishedDoc, saveDraft, publishDoc } from "./page-document.server";
import type { BlockDocument } from "./types";

// vi.mock is hoisted above the imports by vitest at transform time, so the supabase mock still
// applies even though it is written below them (imports-first satisfies the import/first rule).
const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }));
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ from: fromMock }) }));

const realShop = "11111111-1111-1111-1111-111111111111";
const doc: BlockDocument = { kind: "singleton", pageKey: "home", blocks: [
  { id: "h", type: "hero", layout: { x: 0, y: 0, w: 12, h: 2 }, props: { headline: "Hi", subhead: "" } },
] };

beforeEach(() => fromMock.mockReset());

describe("page-document repo", () => {
  it("returns null for a non-uuid (fixture/demo) shop without hitting the DB", async () => {
    const out = await loadPublishedDoc("demo-shop", "home");
    expect(out).toBeNull();
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("loadPublishedDoc maps published_json into a BlockDocument", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: { published_json: doc }, error: null });
    const eq2 = vi.fn(() => ({ maybeSingle }));
    const eq1 = vi.fn(() => ({ eq: eq2 }));
    const select = vi.fn(() => ({ eq: eq1 }));
    fromMock.mockReturnValue({ select });
    const out = await loadPublishedDoc(realShop, "home");
    expect(out).toEqual(doc);
    expect(fromMock).toHaveBeenCalledWith("page_document");
    expect(eq1).toHaveBeenCalledWith("shop_id", realShop); // shop-scoped
  });

  it("loadPublishedDoc returns null when no row / published_json is null", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    fromMock.mockReturnValue({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle }) }) }) });
    expect(await loadPublishedDoc(realShop, "home")).toBeNull();
  });

  it("saveDraft upserts draft_json keyed on (shop_id, page_key)", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    fromMock.mockReturnValue({ upsert });
    await saveDraft(realShop, "home", doc);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ shop_id: realShop, page_key: "home", kind: "singleton", draft_json: doc }),
      { onConflict: "shop_id,page_key" },
    );
  });

  it("publishDoc copies draft_json into published_json", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: { draft_json: doc, kind: "singleton" }, error: null });
    const update = vi.fn().mockResolvedValue({ error: null });
    fromMock
      .mockReturnValueOnce({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle }) }) }) }) // read draft
      .mockReturnValueOnce({ update: () => ({ eq: () => ({ eq: update }) }) }); // write published
    await publishDoc(realShop, "home");
    expect(update).toHaveBeenCalled();
  });

  it("publishDoc throws when there is no draft to publish (fail visibly, rule 12)", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    fromMock.mockReturnValue({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle }) }) }) });
    await expect(publishDoc(realShop, "home")).rejects.toThrow(/no draft/i);
  });
});
